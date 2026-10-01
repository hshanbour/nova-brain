import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config/env.js";
import { createGmailService, GMAIL_SCOPES } from "../src/email/gmail-service.js";
import { createTokenCipher, decodeGmailEncryptionKey } from "../src/email/token-crypto.js";
import { registerGmailTools } from "../src/email/gmail-tools.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createActionPolicy, ApprovalRequiredError } from "../src/policy/action-policy.js";
import { INITIAL_OWNER_PROFILE, OWNER_ID } from "../src/identity/initial-context.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = Object.freeze({
  NOVA_BRAIN_MODEL_PROVIDER: "mock",
  GOOGLE_OAUTH_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
  NOVA_GMAIL_OAUTH_REDIRECT_URI: "https://preview.example/api/integrations/gmail/oauth/callback",
  NOVA_GMAIL_TOKEN_ENCRYPTION_KEY: TEST_KEY,
  NOVA_GMAIL_ACCOUNT_EMAIL: "novadigitalservicesuk@gmail.com",
});

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });

function provider({ email = "novadigitalservicesuk@gmail.com", failSend = false } = {}) {
  const calls = [];
  let exchange = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: String(options.body || ""), authorization: options.headers?.Authorization || null });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      exchange++;
      return jsonResponse({ access_token: `access-${exchange}`, refresh_token: `refresh-${exchange}`, expires_in: 3600, scope: GMAIL_SCOPES.join(" ") });
    }
    if (String(url).endsWith("/profile")) return jsonResponse({ emailAddress: email });
    if (String(url).includes("/messages?") && !String(url).includes("/messages/send")) return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }] });
    if (String(url).includes("/messages/m1?")) return jsonResponse({ id: "m1", threadId: "t1", snippet: "Hello", payload: { headers: [{ name: "From", value: "sender@example.com" }, { name: "Subject", value: "Test" }] } });
    if (String(url).includes("/threads/t1?")) return jsonResponse({
      id: "t1",
      messages: [{
        id: "m1",
        threadId: "t1",
        snippet: "Hello",
        payload: {
          headers: [{ name: "From", value: "sender@example.com" }],
          mimeType: "text/plain",
          body: { data: Buffer.from("Arabic English mixed message مرحبا Nova").toString("base64url") },
        },
      }],
    });
    if (String(url).endsWith("/messages/send")) {
      if (failSend) throw new Error("ambiguous network timeout token=do-not-log");
      return jsonResponse({ id: "gmail-message-1", threadId: "gmail-thread-1" });
    }
    if (String(url).includes("oauth2.googleapis.com/revoke")) return jsonResponse({});
    throw new Error(`Unexpected provider URL: ${url}`);
  };
  return { fetchImpl, calls };
}

async function fixture(options = {}) {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: INITIAL_OWNER_PROFILE });
  const p = provider(options);
  const config = readConfig(ENV);
  const service = createGmailService({ config, storage, ownerId: OWNER_ID, fetchImpl: p.fetchImpl, ...(options.clock ? { clock: options.clock } : {}), logger: { warn() {}, error() {} } });
  return { storage, service, provider: p };
}

async function connect(service) {
  const started = await service.startOAuth();
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  const connected = await service.completeOAuth({ code: "authorization-code", state, session: started.session });
  return { started, state, connected };
}

test("Gmail token encryption uses authenticated AES-256-GCM and rejects tampering", () => {
  const cipher = createTokenCipher({ key: decodeGmailEncryptionKey(TEST_KEY), randomBytesImpl: () => Buffer.alloc(12, 3) });
  const encrypted = cipher.encrypt("refresh-secret");
  assert.equal(cipher.decrypt(encrypted), "refresh-secret");
  assert.equal(JSON.stringify(encrypted).includes("refresh-secret"), false);
  assert.throws(() => cipher.decrypt({ ...encrypted, ciphertext: Buffer.from("changed").toString("base64") }));
});

test("email headers reject injection before a draft can be persisted", async () => {
  const { service, storage } = await fixture();
  await assert.rejects(() => service.prepareDraft({ to: ["safe@example.com"], subject: "Safe\nBcc: attacker@example.com", body: "Body" }), (error) => error.code === "gmail_input_invalid");
  assert.equal((await storage.listActivity(OWNER_ID)).length, 0);
});

test("Gmail configuration is all-or-nothing and enforces the approved mailbox", () => {
  assert.throws(() => readConfig({ GOOGLE_OAUTH_CLIENT_ID: "partial" }), /all five/i);
  assert.throws(() => readConfig({ ...ENV, NOVA_GMAIL_ACCOUNT_EMAIL: "other@example.com" }), /novadigitalservicesuk@gmail.com/);
  assert.equal(readConfig(ENV).gmail.configured, true);
});

test("schema thirteen adds durable owner-scoped Gmail state, tokens, drafts, and send intents", () => {
  assert.equal(SCHEMA_VERSION, 13);
  for (const table of ["nova_gmail_oauth_states", "nova_gmail_connections", "nova_gmail_drafts", "nova_gmail_send_intents"])
    assert.ok(SCHEMA_STATEMENTS.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`)));
  const sends = SCHEMA_STATEMENTS.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS nova_gmail_send_intents"));
  assert.match(sends, /UNIQUE\(owner_id, draft_id\)/);
  assert.match(sends, /'sending','sent','uncertain','failed'/);
});

test("OAuth state is cookie-session bound, expiring, and single-use", async () => {
  const { service, storage } = await fixture();
  const started = await service.startOAuth();
  const auth = new URL(started.authorizationUrl);
  assert.deepEqual(auth.searchParams.get("scope").split(" "), GMAIL_SCOPES);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  const state = auth.searchParams.get("state");
  await assert.rejects(() => service.completeOAuth({ code: "authorization-code", state, session: "wrong-session" }), (error) => error.code === "gmail_oauth_state_rejected");
  const result = await service.completeOAuth({ code: "authorization-code", state, session: started.session });
  assert.deepEqual(result, { connected: true, email: "novadigitalservicesuk@gmail.com", scopes: GMAIL_SCOPES });
  await assert.rejects(() => service.completeOAuth({ code: "authorization-code", state, session: started.session }), (error) => error.code === "gmail_oauth_state_rejected");
  const connection = await storage.getGmailConnection(OWNER_ID);
  assert.equal(JSON.stringify(connection).includes("access-1"), false);
  assert.equal(JSON.stringify(connection).includes("refresh-1"), false);
});

test("expired OAuth state is rejected before any token exchange", async () => {
  let current = new Date("2026-10-01T00:00:00.000Z");
  const { service, provider: p } = await fixture({ clock: () => current });
  const started = await service.startOAuth();
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  current = new Date("2026-10-01T00:10:01.000Z");
  await assert.rejects(() => service.completeOAuth({ code: "authorization-code", state, session: started.session }), (error) => error.code === "gmail_oauth_state_rejected");
  assert.equal(p.calls.length, 0);
});

test("OAuth rejects and revokes a wrong mailbox without storing it", async () => {
  const { service, storage, provider: p } = await fixture({ email: "wrong@gmail.com" });
  const started = await service.startOAuth();
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  await assert.rejects(() => service.completeOAuth({ code: "authorization-code", state, session: started.session }), (error) => error.code === "gmail_wrong_mailbox");
  assert.equal(await storage.getGmailConnection(OWNER_ID), null);
  assert.equal(p.calls.filter((call) => call.url.includes("/revoke")).length, 1);
});

test("Gmail read tools search and read bounded thread content", async () => {
  const { service } = await fixture();
  await connect(service);
  const search = await service.search({ query: "from:sender@example.com", maxResults: 5 });
  assert.equal(search.resultCount, 1);
  assert.equal(search.messages[0].subject, "Test");
  const thread = await service.readThread({ threadId: "t1" });
  assert.equal(thread.messages[0].body, "Arabic English mixed message مرحبا Nova");
});

function sendArguments(draft) {
  return { draftId: draft.id, intentHash: draft.intentHash, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, ...(draft.threadId ? { threadId: draft.threadId } : {}), ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}), ...(draft.references ? { references: draft.references } : {}) };
}

test("gmail_send requires approval containing the exact immutable message and prevents duplicate sends", async () => {
  const { service, storage, provider: p } = await fixture();
  await connect(service);
  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" }) });
  registerGmailTools(registry, { service });
  const draft = await registry.execute("gmail_draft_prepare", { to: ["customer@example.com"], cc: [], bcc: [], subject: "Exact subject", body: "Exact body" }, {});
  const args = sendArguments(draft);
  let pending;
  await assert.rejects(() => registry.execute("gmail_send", args, {}), (error) => { pending = error.approval; return error instanceof ApprovalRequiredError; });
  assert.deepEqual(pending.arguments, args);
  assert.equal(pending.riskLevel, "SENSITIVE");
  await storage.decideApproval(pending.id, OWNER_ID, "approved");
  const sent = await registry.execute("gmail_send", args, { approvalId: pending.id });
  assert.equal(sent.sent, true);
  const repeated = await registry.execute("gmail_send", args, { approvalId: pending.id });
  assert.equal(repeated.idempotent, true);
  assert.equal(p.calls.filter((call) => call.url.endsWith("/messages/send")).length, 1);
  await assert.rejects(() => registry.execute("gmail_send", { ...args, body: "Changed after approval" }, { approvalId: pending.id }), (error) => error.code === "gmail_send_intent_mismatch");
});

test("ambiguous Gmail send outcome is durable and never automatically retried", async () => {
  const { service, storage, provider: p } = await fixture({ failSend: true });
  await connect(service);
  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" }) });
  registerGmailTools(registry, { service });
  const draft = await registry.execute("gmail_draft_prepare", { to: ["customer@example.com"], cc: [], bcc: [], subject: "Safe", body: "Only once" }, {});
  const args = sendArguments(draft);
  let approval;
  await assert.rejects(() => registry.execute("gmail_send", args, {}), (error) => { approval = error.approval; return error instanceof ApprovalRequiredError; });
  await storage.decideApproval(approval.id, OWNER_ID, "approved");
  await assert.rejects(() => registry.execute("gmail_send", args, { approvalId: approval.id }), (error) => error.code === "gmail_provider_unavailable");
  await assert.rejects(() => registry.execute("gmail_send", args, { approvalId: approval.id }), (error) => error.code === "gmail_send_not_retryable");
  assert.equal(p.calls.filter((call) => call.url.endsWith("/messages/send")).length, 1);
});

test("reconnect replaces encrypted credentials and disconnect removes local access before revocation", async () => {
  const { service, storage, provider: p } = await fixture();
  await connect(service);
  const before = await storage.getGmailConnection(OWNER_ID);
  await connect(service);
  const after = await storage.getGmailConnection(OWNER_ID);
  assert.notDeepEqual(after.encryptedRefreshToken, before.encryptedRefreshToken);
  const result = await service.disconnect();
  assert.equal(result.disconnected, true);
  assert.equal(await storage.getGmailConnection(OWNER_ID), null);
  assert.equal(p.calls.filter((call) => call.url.includes("/revoke")).length, 1);
});

function request(method, url, { body, cookie } = {}) {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) };
  return stream;
}
function response() {
  return { statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(chunk = "") { this.body += chunk; } };
}
async function api(app, method, url, options) {
  const res = response();
  await app.handle(request(method, url, options), res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
}

test("Gmail HTTP routes keep tokens out of responses and logs", async () => {
  const p = provider();
  const logs = [];
  const app = createApp({ environment: ENV, gmailFetchImpl: p.fetchImpl, logger: { info() {}, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } } });
  const start = await api(app, "POST", "/api/integrations/gmail/oauth/start");
  assert.equal(start.status, 200);
  assert.match(start.headers["set-cookie"], /HttpOnly/);
  const state = new URL(start.body.authorizationUrl).searchParams.get("state");
  const cookie = start.headers["set-cookie"].split(";")[0];
  const callback = await api(app, "GET", `/api/integrations/gmail/oauth/callback?code=authorization-code&state=${encodeURIComponent(state)}`, { cookie });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, "/?gmail=connected");
  const status = await api(app, "GET", "/api/integrations/gmail/status");
  assert.deepEqual(status.body, { configured: true, connected: true, email: "novadigitalservicesuk@gmail.com", scopes: GMAIL_SCOPES, connectedAt: status.body.connectedAt });
  const exposed = JSON.stringify({ start: start.body, callback: callback.body, status: status.body, logs });
  assert.doesNotMatch(exposed, /test-client-secret|access-1|refresh-1|NOVA_GMAIL_TOKEN_ENCRYPTION_KEY/);
  const disconnected = await api(app, "POST", "/api/integrations/gmail/disconnect");
  assert.equal(disconnected.body.connected, false);
});

test("provider OAuth failures expose only a safe category and never the provider body", async () => {
  const logs = [];
  const providerSecret = "provider-body-secret-never-expose";
  const app = createApp({
    environment: ENV,
    gmailFetchImpl: async () => jsonResponse({ error: "invalid_client", error_description: providerSecret }, 401),
    logger: { info() {}, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
  });
  const start = await api(app, "POST", "/api/integrations/gmail/oauth/start");
  const state = new URL(start.body.authorizationUrl).searchParams.get("state");
  const failed = await api(app, "GET", `/api/integrations/gmail/oauth/callback?code=authorization-code&state=${encodeURIComponent(state)}`, { cookie: start.headers["set-cookie"].split(";")[0] });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, "gmail_oauth_exchange_failed");
  assert.doesNotMatch(JSON.stringify({ response: failed.body, logs }), new RegExp(providerSecret));
});
