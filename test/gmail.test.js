import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config/env.js";
import { createGmailService, GMAIL_SCOPES } from "../src/email/gmail-service.js";
import { createTokenCipher, decodeGmailEncryptionKey } from "../src/email/token-crypto.js";
import { registerGmailTools } from "../src/email/gmail-tools.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createPostgresStorage } from "../src/storage/postgres-storage.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createActionPolicy, ApprovalRequiredError } from "../src/policy/action-policy.js";
import { INITIAL_OWNER_PROFILE, OWNER_ID } from "../src/identity/initial-context.js";
import { createAgent } from "../src/agent/agent.js";
import { isConversationWorkflowTurn, isSelfDevelopmentWorkflowCandidate } from "../src/autonomy/conversation-workflow-intent.js";

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

function gmailMessage({
  id = "m1",
  threadId = "t1",
  from = "sender@example.com",
  replyTo,
  subject = "Test",
  messageId = "<m1@example.com>",
  references,
  body = "Arabic English mixed message مرحبا Nova",
} = {}) {
  const headers = [
    { name: "From", value: from },
    ...(replyTo ? [{ name: "Reply-To", value: replyTo }] : []),
    { name: "Subject", value: subject },
    { name: "Message-ID", value: messageId },
    ...(references ? [{ name: "References", value: references }] : []),
  ];
  return {
    id,
    threadId,
    snippet: body.slice(0, 80),
    payload: {
      headers,
      mimeType: "text/plain",
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };
}

function provider({ email = "novadigitalservicesuk@gmail.com", failSend = false, threadId = "t1", threadMessages } = {}) {
  const calls = [];
  let exchange = 0;
  const messages = threadMessages || [gmailMessage({ threadId })];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: String(options.body || ""), authorization: options.headers?.Authorization || null });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      exchange++;
      return jsonResponse({ access_token: `access-${exchange}`, refresh_token: `refresh-${exchange}`, expires_in: 3600, scope: GMAIL_SCOPES.join(" ") });
    }
    if (String(url).endsWith("/profile")) return jsonResponse({ emailAddress: email });
    if (String(url).includes("/messages?") && !String(url).includes("/messages/send")) return jsonResponse({ messages: messages.map(({ id, threadId: itemThreadId }) => ({ id, threadId: itemThreadId })) });
    const messageMatch = String(url).match(/\/messages\/([^?]+)\?/);
    if (messageMatch) return jsonResponse(messages.find(({ id }) => id === decodeURIComponent(messageMatch[1])) || {}, messages.some(({ id }) => id === decodeURIComponent(messageMatch[1])) ? 200 : 404);
    if (String(url).includes(`/threads/${threadId}?`)) return jsonResponse({ id: threadId, messages });
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

test("same-thread reply preparation normalizes supported single-mailbox From and Reply-To forms", async () => {
  const cases = [
    { from: "customer@example.com", expected: "customer@example.com" },
    { from: "Customer Name <Customer@Example.com>", expected: "customer@example.com" },
    { from: "\"Doe, Jane\" <Jane.Doe@Example.com>", expected: "jane.doe@example.com" },
    { from: "=?UTF-8?B?2KfZhNi52YXYtNin?= <Arabic.Name@Example.com>", expected: "arabic.name@example.com" },
    { from: "ignored@example.com", replyTo: "Replies Team <reply@example.com>", expected: "reply@example.com" },
  ];
  for (const [index, item] of cases.entries()) {
    const threadId = `thread_${index}`;
    const sourceMessageId = `message_${index}`;
    const { service } = await fixture({
      threadId,
      threadMessages: [gmailMessage({ id: sourceMessageId, threadId, from: item.from, replyTo: item.replyTo })],
    });
    await connect(service);
    const draft = await service.prepareReplyDraft({ threadId, sourceMessageId, body: "Thanks — this is my reply." });
    assert.deepEqual(draft.to, [item.expected]);
  }
});

test("same-thread reply preparation fails closed for unsafe destination or unverified source identity", async () => {
  const cases = [
    { name: "malformed mailbox", message: gmailMessage({ from: "not-a-mailbox" }), code: "gmail_input_invalid" },
    { name: "multiple destinations", message: gmailMessage({ from: "One <one@example.com>, Two <two@example.com>" }), code: "gmail_input_invalid" },
    { name: "header injection", message: gmailMessage({ from: "safe@example.com\r\nBcc: attacker@example.com" }), code: "gmail_input_invalid" },
    { name: "own mailbox", message: gmailMessage({ from: "Nova <novadigitalservicesuk@gmail.com>" }), code: "gmail_reply_self_recipient" },
  ];
  for (const item of cases) {
    const { service, storage, provider: p } = await fixture({ threadMessages: [item.message] });
    await connect(service);
    await assert.rejects(
      () => service.prepareReplyDraft({ threadId: "t1", sourceMessageId: "m1", body: "No send." }),
      (error) => error.code === item.code,
      item.name,
    );
    assert.equal((await storage.listActivity(OWNER_ID)).some(({ action }) => action === "gmail_draft_prepared"), false);
    assert.equal(p.calls.some(({ url }) => url.endsWith("/messages/send") || url.includes("/drafts")), false);
  }

  const wrongMessage = await fixture(); await connect(wrongMessage.service);
  await assert.rejects(
    () => wrongMessage.service.prepareReplyDraft({ threadId: "t1", sourceMessageId: "not_in_thread", body: "No send." }),
    (error) => error.code === "gmail_reply_source_not_found",
  );

  const mismatchedMembership = await fixture({ threadMessages: [gmailMessage({ id: "m1", threadId: "different_thread" })] });
  await connect(mismatchedMembership.service);
  await assert.rejects(
    () => mismatchedMembership.service.prepareReplyDraft({ threadId: "t1", sourceMessageId: "m1", body: "No send." }),
    (error) => error.code === "gmail_reply_source_not_found",
  );
});

test("same-thread reply draft derives authoritative metadata and preserves formal exactly-once send approval", async () => {
  const referenceIds = Array.from({ length: 24 }, (_, index) => `<prior-${index}@example.com>`);
  const sourceMessageId = "source_message";
  const sourceRfcMessageId = "<source-rfc@example.com>";
  const threadMessages = [gmailMessage({
    id: sourceMessageId,
    threadId: "thread_reply",
    from: "Sender Name <sender@example.com>",
    replyTo: "Reply Desk <reply@example.com>",
    subject: "Re: Re: Project details",
    messageId: sourceRfcMessageId,
    references: `${referenceIds.join(" ")} ${sourceRfcMessageId}`,
  })];
  const baseStorage = createInMemoryStorage();
  await baseStorage.initialize({ owner: INITIAL_OWNER_PROFILE });
  let sendIntentClaims = 0;
  const storage = { ...baseStorage, async claimGmailSendIntent(...args) { sendIntentClaims += 1; return baseStorage.claimGmailSendIntent(...args); } };
  const p = provider({ threadId: "thread_reply", threadMessages });
  const service = createGmailService({ config: readConfig(ENV), storage, ownerId: OWNER_ID, fetchImpl: p.fetchImpl, logger: { warn() {}, error() {} } });
  await connect(service);
  const conversationId = "same-thread-reply";
  const run = await storage.createRun({ ownerId: OWNER_ID, conversationId, goal: "prepare same-thread reply", status: "running" });

  const oldDraft = await service.prepareDraft({ to: ["old@example.com"], subject: "Older standalone draft", body: "Older body" }, { runId: run.id });
  const reply = await service.prepareReplyDraft({ threadId: "thread_reply", sourceMessageId, body: "Here is the requested information." }, { runId: run.id });

  assert.deepEqual(reply.to, ["reply@example.com"]);
  assert.equal(reply.subject, "Re: Project details");
  assert.equal(reply.threadId, "thread_reply");
  assert.equal(reply.inReplyTo, sourceRfcMessageId);
  const references = reply.references.split(" ");
  assert.equal(references.length, 20);
  assert.equal(references.at(-1), sourceRfcMessageId);
  assert.equal(references.filter((value) => value === sourceRfcMessageId).length, 1);
  assert.ok(reply.references.length <= 900);
  const preparedActivity = (await storage.listActivity(OWNER_ID)).filter(({ action }) => action === "gmail_draft_prepared");
  assert.equal(preparedActivity.filter(({ tool }) => tool === "gmail_reply_draft_prepare").length, 1);
  assert.equal(await storage.getGmailDraft(reply.id, OWNER_ID) !== null, true);
  assert.equal((await service.currentDraft({}, { conversationId })).draftId, reply.id);
  assert.notEqual(reply.id, oldDraft.id);
  assert.deepEqual(await storage.listApprovals(OWNER_ID), []);
  assert.equal(sendIntentClaims, 0);
  assert.equal(p.calls.some(({ url }) => url.endsWith("/messages/send") || url.includes("/drafts")), false);

  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" }) });
  registerGmailTools(registry, { service });
  const exact = await registry.execute("gmail_draft_current", {}, { conversationId });
  let approval;
  await assert.rejects(
    () => registry.execute("gmail_send", exact, { conversationId, runId: run.id }),
    (error) => { approval = error.approval; return error instanceof ApprovalRequiredError; },
  );
  assert.deepEqual(approval.arguments, exact);
  assert.equal(approval.riskLevel, "SENSITIVE");
  assert.equal(sendIntentClaims, 0);
  assert.equal(p.calls.filter(({ url }) => url.endsWith("/messages/send")).length, 0);

  await storage.decideApproval(approval.id, OWNER_ID, "approved");
  const sent = await registry.execute("gmail_send", exact, { approvalId: approval.id, conversationId, runId: run.id });
  const repeated = await registry.execute("gmail_send", exact, { approvalId: approval.id, conversationId, runId: run.id });
  assert.equal(sent.sent, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(sendIntentClaims, 2);
  const sendCalls = p.calls.filter(({ url }) => url.endsWith("/messages/send"));
  assert.equal(sendCalls.length, 1);
  const providerBody = JSON.parse(sendCalls[0].body);
  assert.equal(providerBody.threadId, "thread_reply");
  const raw = Buffer.from(providerBody.raw, "base64url").toString("utf8");
  assert.match(raw, /To: reply@example\.com\r\n/);
  assert.match(raw, /Subject: Re: Project details\r\n/);
  assert.match(raw, /In-Reply-To: <source-rfc@example\.com>\r\n/);
  assert.match(raw, /References: .*<source-rfc@example\.com>\r\n/);
});

test("agent guidance selects the structured same-thread reply tool without model-authored reply headers", async () => {
  const { service, storage } = await fixture();
  await connect(service);
  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" }) });
  registerGmailTools(registry, { service });
  let call = 0;
  const agent = createAgent({ storage, ownerId: OWNER_ID, toolRegistry: registry, modelProvider: {
    name: "same-thread-script",
    async generate(input) {
      call += 1;
      if (call === 1) {
        assert.match(input.systemContext, /GMAIL SAME-THREAD REPLIES/);
        assert.equal(input.tools.some(({ name }) => name === "gmail_reply_draft_prepare"), true);
        return { type: "tool_calls", continuationToken: "search", toolCalls: [{ id: "search", name: "gmail_search", arguments: { query: "from:sender@example.com", maxResults: 5 } }] };
      }
      if (call === 2) return { type: "tool_calls", continuationToken: "read", toolCalls: [{ id: "read", name: "gmail_thread_read", arguments: { threadId: "t1" } }] };
      if (call === 3) {
        const source = input.toolResults[0].output.result.messages[0];
        return { type: "tool_calls", continuationToken: "draft", toolCalls: [{ id: "reply", name: "gmail_reply_draft_prepare", arguments: { threadId: source.threadId, sourceMessageId: source.id, body: "Structured reply body." } }] };
      }
      return { type: "final", message: "The reply draft is ready and has not been sent." };
    },
  } });
  const result = await agent.run({ message: "Read the latest reply and prepare an appropriate reply in the same Gmail thread. Do not send it.", conversationId: "agent-same-thread" });
  assert.deepEqual(result.toolCalls.map(({ name }) => name), ["gmail_search", "gmail_thread_read", "gmail_reply_draft_prepare"]);
  assert.equal(result.toolCalls.some(({ name }) => name === "gmail_send"), false);
  assert.deepEqual(await storage.listApprovals(OWNER_ID), []);
});

test("email test and approval wording bypasses a completed historical coding artifact and prepares only an internal draft", async () => {
  const request=`Prepare a test email to hamodehshanbour@yahoo.com with the subject “Nova Email V1 Test” and the body “This is the first real email sent through Nova Email V1.”

Do not send it yet. Show me the exact email and wait for my explicit approval before sending.`;
  const baseStorage=createInMemoryStorage();
  await baseStorage.initialize({owner:INITIAL_OWNER_PROFILE});
  const p=provider();
  let sendIntentClaims=0;
  const storage={...baseStorage,async claimGmailSendIntent(...args){sendIntentClaims+=1;return baseStorage.claimGmailSendIntent(...args);}};
  const service=createGmailService({config:readConfig(ENV),storage,ownerId:OWNER_ID,fetchImpl:p.fetchImpl,logger:{warn(){},error(){}}});
  const historicalId=`coding_${"9".repeat(32)}`;
  let historical=await storage.createAutonomyTask({id:historicalId,ownerId:OWNER_ID,projectId:"nova-brain",title:"Completed Console implementation",objective:"Implement a prior Console change",taskType:"coding_delegation",metadata:{}});
  historical=await storage.updateAutonomyTask(historical.id,OWNER_ID,{status:"completed",currentPhase:"completed",completedAt:new Date().toISOString()},historical.stateVersion);

  const registry=createToolRegistry({policy:createActionPolicy({storage,ownerId:OWNER_ID,approvedBranch:"feature"})});
  registerGmailTools(registry,{service});
  let workflowRouteCalls=0;
  const generated=[];
  const modelProvider={
    name:"scripted",
    async generate(input){
      generated.push(input);
      if(generated.length===1)return{type:"tool_calls",continuationToken:"gmail-draft",toolCalls:[{id:"prepare-email",name:"gmail_draft_prepare",arguments:{to:["hamodehshanbour@yahoo.com"],cc:[],bcc:[],subject:"Nova Email V1 Test",body:"This is the first real email sent through Nova Email V1."}}]};
      return{type:"final",message:"To: hamodehshanbour@yahoo.com\nSubject: Nova Email V1 Test\n\nThis is the first real email sent through Nova Email V1.\n\nThis draft has not been sent."};
    },
  };
  const agent=createAgent({
    storage,
    ownerId:OWNER_ID,
    modelProvider,
    toolRegistry:registry,
    routeDurableRequest:async({message})=>{
      const candidates=(await storage.listAutonomyTasks(OWNER_ID)).filter(isSelfDevelopmentWorkflowCandidate);
      assert.deepEqual(candidates.map(item=>item.id),[historicalId]);
      if(!isConversationWorkflowTurn(message))return null;
      workflowRouteCalls+=1;
      throw new Error("ordinary email drafting must not enter workflow intake");
    },
  });

  const result=await agent.run({message:request,conversationId:"gmail-routing-regression"});

  assert.equal(workflowRouteCalls,0);
  assert.equal(generated.length,2);
  assert.equal(generated[0].tools.some(tool=>tool.name==="gmail_draft_prepare"),true);
  assert.equal(generated[0].tools.some(tool=>tool.name==="gmail_send"),true);
  assert.deepEqual(result.toolCalls.map(call=>call.name),["gmail_draft_prepare"]);
  const draftId=result.toolCalls[0].result.id;
  assert.deepEqual(await storage.getGmailDraft(draftId,OWNER_ID),{
    id:draftId,
    ownerId:OWNER_ID,
    to:["hamodehshanbour@yahoo.com"],
    cc:[],
    bcc:[],
    subject:"Nova Email V1 Test",
    body:"This is the first real email sent through Nova Email V1.",
    threadId:null,
    inReplyTo:null,
    references:null,
    intentHash:result.toolCalls[0].result.intentHash,
    createdAt:(await storage.getGmailDraft(draftId,OWNER_ID)).createdAt,
  });
  assert.equal(result.toolCalls.some(call=>call.name==="gmail_send"),false);
  assert.deepEqual(await storage.listApprovals(OWNER_ID),[]);
  assert.equal(sendIntentClaims,0);
  assert.equal(p.calls.filter(call=>call.url.endsWith("/messages/send")).length,0);
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

test("a prepared draft resolves across a refreshed agent turn and stops at immutable send approval", async () => {
  const { service, storage, provider: p } = await fixture();
  await connect(service);
  const conversationId = "gmail-multi-turn";
  const policy = createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" });
  const firstRegistry = createToolRegistry({ policy }); registerGmailTools(firstRegistry, { service });
  let firstCalls = 0;
  const firstAgent = createAgent({ storage, ownerId: OWNER_ID, toolRegistry: firstRegistry, modelProvider: {
    name: "prepare-script",
    async generate() {
      firstCalls += 1;
      if (firstCalls === 1) return { type: "tool_calls", continuationToken: "prepared", toolCalls: [{ id: "prepare", name: "gmail_draft_prepare", arguments: { to: ["hamodehshanbour@yahoo.com"], cc: [], bcc: [], subject: "Nova Email V1 Test", body: "This is the first real email sent through Nova Email V1." } }] };
      return { type: "final", message: "The internal draft is ready and has not been sent." };
    },
  } });
  const prepared = await firstAgent.run({ message: "Prepare this email but do not send it.", conversationId });
  const originalDraft = prepared.toolCalls[0].result;

  const refreshedRegistry = createToolRegistry({ policy }); registerGmailTools(refreshedRegistry, { service });
  let secondCalls = 0;
  const secondAgent = createAgent({ storage, ownerId: OWNER_ID, toolRegistry: refreshedRegistry, modelProvider: {
    name: "continuation-script",
    async generate(input) {
      secondCalls += 1;
      if (secondCalls === 1) {
        assert.match(input.systemContext, /first call gmail_draft_current/i);
        return { type: "tool_calls", continuationToken: "resolved", toolCalls: [{ id: "current", name: "gmail_draft_current", arguments: {} }] };
      }
      const exact = input.toolResults[0].output.result;
      assert.deepEqual(exact, { draftId: originalDraft.id, intentHash: originalDraft.intentHash, to: originalDraft.to, cc: [], bcc: [], subject: originalDraft.subject, body: originalDraft.body });
      return { type: "tool_calls", continuationToken: "approval", toolCalls: [{ id: "send", name: "gmail_send", arguments: exact }] };
    },
  } });
  const pending = await secondAgent.run({ message: "Send it now.", conversationId });

  assert.deepEqual(pending.toolCalls.map(({ name }) => name), ["gmail_draft_current", "gmail_send"]);
  assert.equal(pending.toolCalls.some(({ name }) => name === "gmail_search" || name === "gmail_draft_prepare"), false);
  assert.equal(pending.runStatus, "waiting_for_approval");
  assert.deepEqual(pending.approval.arguments, sendArguments(originalDraft));
  assert.equal(p.calls.filter((call) => call.url.endsWith("/messages/send")).length, 0);

  await storage.decideApproval(pending.approval.id, OWNER_ID, "approved");
  const afterRefreshRegistry = createToolRegistry({ policy }); registerGmailTools(afterRefreshRegistry, { service });
  const sent = await afterRefreshRegistry.execute("gmail_send", pending.approval.arguments, { approvalId: pending.approval.id, runId: pending.runId, conversationId });
  const repeated = await afterRefreshRegistry.execute("gmail_send", pending.approval.arguments, { approvalId: pending.approval.id, runId: pending.runId, conversationId });
  assert.equal(sent.sent, true); assert.equal(repeated.idempotent, true);
  assert.equal(p.calls.filter((call) => call.url.endsWith("/messages/send")).length, 1);
});

test("chat text claiming approval remains non-authoritative and reuses the one pending Gmail approval", async () => {
  const { service, storage, provider: p } = await fixture();
  await connect(service);
  const conversationId = "gmail-chat-approval-is-not-formal";
  const preparingRun = await storage.createRun({ id: "preparing-run", ownerId: OWNER_ID, conversationId, goal: "prepare", status: "running" });
  const draft = await service.prepareDraft({ to: ["hamodehshanbour@yahoo.com"], subject: "Nova Email V1 Test", body: "This is the first real email sent through Nova Email V1." }, { runId: preparingRun.id });
  const arguments_ = sendArguments(draft);
  const policy = createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" });

  const attempt = async (message, runId) => {
    await storage.createRun({ id: runId, ownerId: OWNER_ID, conversationId, goal: message, status: "running" });
    const registry = createToolRegistry({ policy }); registerGmailTools(registry, { service });
    let approval;
    await assert.rejects(
      () => registry.execute("gmail_send", arguments_, { runId, conversationId }),
      (error) => { approval = error.approval; return error instanceof ApprovalRequiredError; },
    );
    return approval;
  };

  const first = await attempt("send it now", "send-run-one");
  const typedClaim = await attempt("I approve", "send-run-two");
  assert.equal(typedClaim.id, first.id);
  assert.equal((await storage.listApprovals(OWNER_ID, { status: "pending", conversationId })).length, 1);
  assert.equal(p.calls.filter((call) => call.url.endsWith("/messages/send")).length, 0);
});

test("current draft resolution is owner and conversation isolated and deterministically selects the latest prepared draft", async () => {
  const { service, storage } = await fixture();
  const prepareIn = async (conversationId, subject) => {
    const run = await storage.createRun({ ownerId: OWNER_ID, conversationId, goal: subject, status: "running" });
    return service.prepareDraft({ to: ["customer@example.com"], subject, body: `Body for ${subject}` }, { runId: run.id });
  };
  const only = await prepareIn("one-draft", "Only draft");
  assert.equal((await service.currentDraft({}, { conversationId: "one-draft" })).draftId, only.id);
  await assert.rejects(() => service.currentDraft({}, { conversationId: "different-conversation" }), (error) => error.code === "gmail_draft_not_found");

  const foreignRun = await storage.createRun({ ownerId: "another-owner", conversationId: "foreign-only", goal: "Foreign", status: "running" });
  const foreign = await storage.createGmailDraft({ id: "foreign-draft", ownerId: "another-owner", to: ["other@example.com"], cc: [], bcc: [], subject: "Foreign", body: "Private", threadId: null, inReplyTo: null, references: null, intentHash: "foreign-hash" });
  await storage.appendActivity({ ownerId: "another-owner", runId: foreignRun.id, action: "gmail_draft_prepared", tool: "gmail_draft_prepare", status: "completed", summary: "Foreign", metadata: { draftId: foreign.id } });
  await assert.rejects(() => service.currentDraft({}, { conversationId: "foreign-only" }), (error) => error.code === "gmail_draft_not_found");

  await prepareIn("multiple", "First"); const latest = await prepareIn("multiple", "Second");
  assert.equal((await service.currentDraft({}, { conversationId: "multiple" })).draftId, latest.id);
});

test("PostgreSQL current-draft lookup is bounded to exact owner and conversation through the preparing run", async () => {
  const queries = [], row = { id: "draft-postgres", owner_id: OWNER_ID, to_recipients: ["customer@example.com"], cc_recipients: [], bcc_recipients: [], subject: "Stored", body: "Exact", thread_id: null, in_reply_to: null, references_header: null, intent_hash: "a".repeat(64), created_at: "2026-10-01T10:00:00.000Z" };
  const storage = createPostgresStorage({ sqlClient: { async query(text, params) { queries.push({ text, params }); return [row]; } } });
  const drafts = await storage.listConversationGmailDrafts(OWNER_ID, "exact-conversation", { limit: 2 });
  assert.equal(drafts[0].id, row.id);
  assert.deepEqual(queries[0].params, [OWNER_ID, "exact-conversation", 2]);
  assert.match(queries[0].text, /event\.owner_id=\$1 AND execution\.conversation_id=\$2/);
  assert.match(queries[0].text, /execution\.owner_id=event\.owner_id/);
  assert.match(queries[0].text, /draft\.owner_id=event\.owner_id/);
  assert.match(queries[0].text, /event\.tool IN \('gmail_draft_prepare','gmail_reply_draft_prepare'\)/);
  assert.match(queries[0].text, /GROUP BY draft\.id ORDER BY MAX\(event\.sequence\) DESC/);
});

test("Gmail tool failures persist only bounded safe diagnostics", async () => {
  const { service, storage } = await fixture();
  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" }) }); registerGmailTools(registry, { service });
  let calls = 0;
  const agent = createAgent({ storage, ownerId: OWNER_ID, toolRegistry: registry, modelProvider: {
    name: "invalid-gmail-script",
    async generate() {
      calls += 1;
      if (calls === 1) return { type: "tool_calls", continuationToken: "invalid", toolCalls: [{ id: "bad-draft", name: "gmail_draft_prepare", arguments: { to: [], subject: "private-subject", body: "private-body-must-not-leak" } }] };
      return { type: "final", message: "The draft could not be prepared safely." };
    },
  } });
  await agent.run({ message: "Prepare the email.", conversationId: "safe-diagnostics" });
  const failed = (await storage.listActivity(OWNER_ID)).find((event) => event.action === "tool_failed" && event.tool === "gmail_draft_prepare");
  assert.equal(failed.metadata.error.code, "gmail_input_invalid");
  assert.equal(failed.metadata.error.diagnostics.fieldPath, "gmail_draft_prepare.to");
  assert.equal(failed.metadata.error.diagnostics.validationCode, "input_invalid");
  assert.doesNotMatch(JSON.stringify(failed), /private-subject|private-body-must-not-leak/);
});

test("Gmail diagnostics distinguish schema provider and storage failures without content leakage", async () => {
  const cases = [
    {
      name: "gmail_draft_prepare", arguments: { to: "recipient-private@example.com", subject: "schema-private", body: "schema-body-private" },
      service: {}, expectedCode: "schema_mismatch", expectedCategory: undefined,
    },
    {
      name: "gmail_search", arguments: { query: "provider-private-query" },
      service: { async search() { throw Object.assign(new Error("private provider response"), { code: "gmail_provider_error", category: "provider" }); } }, expectedCode: "gmail_provider_error", expectedCategory: "provider",
    },
    {
      name: "gmail_draft_prepare", arguments: { to: ["storage-private@example.com"], subject: "storage-private", body: "storage-body-private" },
      service: { async prepareDraft() { throw new Error("private postgres failure detail"); } }, expectedCode: "gmail_storage_failure", expectedCategory: undefined,
    },
  ];
  for (const item of cases) {
    const storage = createInMemoryStorage(); await storage.initialize({ owner: INITIAL_OWNER_PROFILE });
    const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" }) });
    registerGmailTools(registry, { service: item.service });
    let calls = 0;
    const agent = createAgent({ storage, ownerId: OWNER_ID, toolRegistry: registry, modelProvider: { name: "diagnostic-script", async generate() {
      calls += 1;
      return calls === 1
        ? { type: "tool_calls", continuationToken: "failed", toolCalls: [{ id: `failure-${item.expectedCode}`, name: item.name, arguments: item.arguments }] }
        : { type: "final", message: "The Gmail operation failed safely." };
    } } });
    await agent.run({ message: "Run the bounded Gmail diagnostic.", conversationId: `diagnostic-${item.expectedCode}` });
    const failed = (await storage.listActivity(OWNER_ID)).find((event) => event.action === "tool_failed");
    assert.equal(failed.metadata.error.code, item.expectedCode);
    assert.equal(failed.metadata.error.diagnostics?.category, item.expectedCategory);
    assert.doesNotMatch(JSON.stringify(failed), /recipient-private|schema-private|schema-body-private|provider-private|private provider|storage-private|storage-body-private|private postgres/);
  }
});

test("rejecting a Gmail send approval never invokes the provider", async () => {
  const { service, storage, provider: p } = await fixture(); await connect(service);
  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "feature" }) }); registerGmailTools(registry, { service });
  const draft = await registry.execute("gmail_draft_prepare", { to: ["customer@example.com"], subject: "Reject", body: "Do not send" }, {});
  let approval;
  await assert.rejects(() => registry.execute("gmail_send", sendArguments(draft), {}), (error) => { approval = error.approval; return error instanceof ApprovalRequiredError; });
  await storage.decideApproval(approval.id, OWNER_ID, "rejected");
  await assert.rejects(() => registry.execute("gmail_send", sendArguments(draft), { approvalId: approval.id }), /does not authorize/i);
  assert.equal(p.calls.filter((call) => call.url.endsWith("/messages/send")).length, 0);
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
