import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  buildRawEmail,
  deriveReplyReferences,
  deriveReplySubject,
  draftIntentHash,
  extractMessage,
  normalizeDraft,
  normalizeRfcMessageId,
  normalizeSingleMailbox,
} from "./mime.js";
import { createTokenCipher, decodeGmailEncryptionKey } from "./token-crypto.js";

export const GMAIL_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
]);
export const GMAIL_OAUTH_COOKIE = "nova_gmail_oauth_session";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(message, { code = "gmail_error", statusCode = 502, category = "provider" } = {}) {
    super(message);
    this.name = "GmailError";
    this.code = code;
    this.statusCode = statusCode;
    this.category = category;
  }
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const base64url = (value) => Buffer.from(value).toString("base64url");
const providerError = (operation, status, providerCode) => {
  const reconnect = operation !== "OAuth exchange" && (status === 401 || (operation === "token refresh" && providerCode === "invalid_grant"));
  const oauthConfiguration = operation === "OAuth exchange" && [400, 401].includes(status);
  return new GmailError(`Gmail ${operation} failed safely.`, {
    code: reconnect ? "gmail_reconnect_required" : oauthConfiguration ? "gmail_oauth_exchange_failed" : "gmail_provider_error",
    statusCode: reconnect ? 409 : 502,
    category: reconnect ? "authentication" : oauthConfiguration ? "configuration" : "provider",
  });
};

export function createGmailService({
  config,
  storage,
  ownerId,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  randomBytesImpl = randomBytes,
  randomUUIDImpl = randomUUID,
  logger = console,
}) {
  const gmail = config.gmail;
  const cipher = gmail.configured
    ? createTokenCipher({ key: decodeGmailEncryptionKey(gmail.tokenEncryptionKey), randomBytesImpl })
    : null;

  function requireConfigured() {
    if (!gmail.configured)
      throw new GmailError("Gmail is not configured.", {
        code: "gmail_not_configured",
        statusCode: 503,
        category: "configuration",
      });
  }

  async function fetchJson(url, options, operation) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), ...options });
    } catch {
      throw new GmailError(`Gmail ${operation} could not be reached.`, {
        code: "gmail_provider_unavailable",
        statusCode: 503,
        category: "network",
      });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw providerError(operation, response.status, body?.error);
    return body;
  }

  async function accessToken() {
    requireConfigured();
    const connection = await storage.getGmailConnection(ownerId);
    if (!connection)
      throw new GmailError("Gmail must be connected first.", {
        code: "gmail_not_connected",
        statusCode: 409,
        category: "authentication",
      });
    if (
      connection.encryptedAccessToken &&
      new Date(connection.accessTokenExpiresAt).getTime() - clock().getTime() > 60_000
    ) return cipher.decrypt(connection.encryptedAccessToken);

    const refreshToken = cipher.decrypt(connection.encryptedRefreshToken);
    const token = await fetchJson(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: gmail.clientId,
        client_secret: gmail.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }, "token refresh");
    if (typeof token?.access_token !== "string" || !token.access_token)
      throw providerError("token refresh", 502);
    await storage.saveGmailConnection({
      ...connection,
      ownerId,
      encryptedAccessToken: cipher.encrypt(token.access_token),
      accessTokenExpiresAt: new Date(clock().getTime() + Number(token.expires_in || 3600) * 1000).toISOString(),
      encryptedRefreshToken: connection.encryptedRefreshToken,
    });
    return token.access_token;
  }

  async function gmailJson(path, options = {}, operation = "request") {
    const token = await accessToken();
    return fetchJson(`${GMAIL_API}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
    }, operation);
  }

  function gmailId(value, name) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
      throw Object.assign(new Error(`A valid Gmail ${name} is required.`), { code: "gmail_input_invalid", statusCode: 400 });
    return value;
  }

  async function loadThread(threadId) {
    return gmailJson(`/threads/${encodeURIComponent(gmailId(threadId, "thread ID"))}?format=full`, {}, "thread read");
  }

  async function persistDraft(draft, context, tool) {
    const intentHash = draftIntentHash(draft);
    const saved = await storage.createGmailDraft({ id: `email_${randomUUIDImpl().replaceAll("-", "")}`, ownerId, ...draft, intentHash });
    await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: "gmail_draft_prepared", tool, status: "completed", summary: "Prepared an internal Nova email draft.", metadata: { draftId: saved.id, recipientCount: saved.to.length + saved.cc.length + saved.bcc.length } });
    return saved;
  }

  async function revokeCredential(token) {
    try {
      const response = await fetchImpl(GOOGLE_REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    configured: gmail.configured,
    async status() {
      const connection = gmail.configured ? await storage.getGmailConnection(ownerId) : null;
      return {
        configured: gmail.configured,
        connected: Boolean(connection),
        email: connection?.email || null,
        scopes: GMAIL_SCOPES,
        connectedAt: connection?.connectedAt || null,
      };
    },
    async startOAuth() {
      requireConfigured();
      const state = base64url(randomBytesImpl(32));
      const session = base64url(randomBytesImpl(32));
      const verifier = base64url(randomBytesImpl(48));
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      const expiresAt = new Date(clock().getTime() + 10 * 60_000).toISOString();
      await storage.saveGmailOAuthState({
        stateHash: digest(state),
        ownerId,
        sessionHash: digest(session),
        encryptedCodeVerifier: cipher.encrypt(verifier),
        expiresAt,
      });
      const authorizationUrl = new URL(GOOGLE_AUTH);
      authorizationUrl.search = new URLSearchParams({
        client_id: gmail.clientId,
        redirect_uri: gmail.redirectUri,
        response_type: "code",
        scope: GMAIL_SCOPES.join(" "),
        state,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return { authorizationUrl: authorizationUrl.toString(), session, expiresAt };
    },
    async completeOAuth({ code, state, session }) {
      requireConfigured();
      if (![code, state, session].every((value) => typeof value === "string" && value.length >= 8))
        throw new GmailError("The Gmail OAuth callback is invalid or expired.", {
          code: "gmail_oauth_invalid",
          statusCode: 400,
          category: "validation",
        });
      const oauthState = await storage.consumeGmailOAuthState({
        stateHash: digest(state),
        ownerId,
        sessionHash: digest(session),
        consumedAt: clock().toISOString(),
      });
      if (!oauthState)
        throw new GmailError("The Gmail OAuth state is invalid, expired, or already used.", {
          code: "gmail_oauth_state_rejected",
          statusCode: 400,
          category: "csrf",
        });
      const verifier = cipher.decrypt(oauthState.encryptedCodeVerifier);
      const token = await fetchJson(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: gmail.clientId,
          client_secret: gmail.clientSecret,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: gmail.redirectUri,
        }),
      }, "OAuth exchange");
      if (typeof token?.access_token !== "string" || typeof token?.refresh_token !== "string")
        throw providerError("OAuth exchange", 502);
      const profile = await fetchJson(`${GMAIL_API}/profile`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }, "mailbox verification");
      const actualEmail = String(profile?.emailAddress || "").toLowerCase();
      if (actualEmail !== gmail.accountEmail) {
        await revokeCredential(token.refresh_token);
        throw new GmailError("The authorized Google account is not Nova's approved mailbox.", {
          code: "gmail_wrong_mailbox",
          statusCode: 403,
          category: "authorization",
        });
      }
      const scope = new Set(String(token.scope || "").split(/\s+/).filter(Boolean));
      if (GMAIL_SCOPES.some((required) => !scope.has(required))) {
        await revokeCredential(token.refresh_token);
        throw new GmailError("Google did not grant all required Gmail scopes.", {
          code: "gmail_scope_missing",
          statusCode: 403,
          category: "authorization",
        });
      }
      const saved = await storage.saveGmailConnection({
        ownerId,
        email: actualEmail,
        scopes: [...scope].sort(),
        encryptedAccessToken: cipher.encrypt(token.access_token),
        accessTokenExpiresAt: new Date(clock().getTime() + Number(token.expires_in || 3600) * 1000).toISOString(),
        encryptedRefreshToken: cipher.encrypt(token.refresh_token),
      });
      await storage.appendActivity({
        ownerId,
        action: "gmail_connected",
        tool: null,
        status: "completed",
        summary: "Connected Nova's approved Gmail mailbox.",
        metadata: { email: saved.email },
      });
      return { connected: true, email: saved.email, scopes: GMAIL_SCOPES };
    },
    async disconnect() {
      requireConfigured();
      const connection = await storage.deleteGmailConnection(ownerId);
      if (!connection) return { connected: false, disconnected: false };
      const token = cipher.decrypt(connection.encryptedRefreshToken);
      const revoked = await revokeCredential(token);
      if (!revoked)
        logger.warn("Gmail token revocation could not be confirmed", { category: "network" });
      await storage.appendActivity({
        ownerId,
        action: "gmail_disconnected",
        status: "completed",
        summary: "Disconnected Nova's Gmail mailbox locally.",
        metadata: { providerRevocationConfirmed: revoked },
      });
      return { connected: false, disconnected: true, providerRevocationConfirmed: revoked };
    },
    async search({ query, maxResults = 10 }, context = {}) {
      const bounded = Math.floor(Math.min(20, Math.max(1, Number(maxResults) || 10)));
      if (typeof query !== "string" || !query.trim() || query.length > 500)
        throw Object.assign(new Error("A bounded Gmail search query is required."), { code: "gmail_input_invalid", statusCode: 400 });
      const params = new URLSearchParams({ q: query.trim(), maxResults: String(bounded) });
      const result = await gmailJson(`/messages?${params}`, {}, "search");
      const messages = await Promise.all((result.messages || []).slice(0, bounded).map(async ({ id, threadId }) => {
        const item = await gmailJson(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {}, "message metadata");
        return { id, threadId, snippet: String(item.snippet || "").slice(0, 500), ...extractMessage(item.payload) };
      }));
      await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: "gmail_search_completed", tool: "gmail_search", status: "completed", summary: "Searched the connected Gmail mailbox.", metadata: { resultCount: messages.length } });
      return { query: query.trim(), messages, resultCount: messages.length };
    },
    async readThread({ threadId }, context = {}) {
      gmailId(threadId, "thread ID");
      const thread = await loadThread(threadId);
      const messages = (thread.messages || []).slice(-50).map((item) => ({
        id: item.id,
        threadId: item.threadId,
        snippet: String(item.snippet || "").slice(0, 500),
        ...extractMessage(item.payload),
      }));
      await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: "gmail_thread_read_completed", tool: "gmail_thread_read", status: "completed", summary: "Read a Gmail thread.", metadata: { threadId, messageCount: messages.length } });
      return { id: thread.id, messages };
    },
    async prepareDraft(input, context = {}) {
      const draft = normalizeDraft(input);
      return persistDraft(draft, context, "gmail_draft_prepare");
    },
    async prepareReplyDraft({ threadId, sourceMessageId, body }, context = {}) {
      const exactThreadId = gmailId(threadId, "thread ID");
      const exactSourceMessageId = gmailId(sourceMessageId, "source message ID");
      const thread = await loadThread(exactThreadId);
      if (thread?.id !== exactThreadId)
        throw new GmailError("The Gmail reply thread could not be verified.", { code: "gmail_reply_thread_mismatch", statusCode: 409, category: "state" });
      const sourceItem = (thread.messages || []).find((item) => item?.id === exactSourceMessageId);
      if (!sourceItem || sourceItem.threadId !== exactThreadId)
        throw new GmailError("The selected Gmail source message does not belong to this thread.", { code: "gmail_reply_source_not_found", statusCode: 404, category: "state" });
      const source = { id: sourceItem.id, threadId: sourceItem.threadId, ...extractMessage(sourceItem.payload) };
      const destination = normalizeSingleMailbox(source.replyTo || source.from, source.replyTo ? "replyTo" : "from");
      if (destination === gmail.accountEmail.toLowerCase())
        throw new GmailError("Nova will not prepare a reply addressed only to its own Gmail mailbox.", { code: "gmail_reply_self_recipient", statusCode: 400, category: "validation" });
      const inReplyTo = normalizeRfcMessageId(source.messageId, "messageId");
      const draft = normalizeDraft({
        to: [destination],
        cc: [],
        bcc: [],
        subject: deriveReplySubject(source.subject),
        body,
        threadId: exactThreadId,
        inReplyTo,
        references: deriveReplyReferences(source.references, inReplyTo),
      });
      return persistDraft(draft, context, "gmail_reply_draft_prepare");
    },
    async currentDraft(_input, context = {}) {
      if (typeof context.conversationId !== "string" || !context.conversationId)
        throw new GmailError("A conversation-bound Gmail draft is required.", { code: "gmail_draft_not_found", statusCode: 404, category: "state" });
      const candidates = await storage.listConversationGmailDrafts(ownerId, context.conversationId, { limit: 1 });
      if (candidates.length === 0)
        throw new GmailError("No prepared Gmail draft exists in this conversation.", { code: "gmail_draft_not_found", statusCode: 404, category: "state" });
      const [draft] = candidates;
      return {
        draftId: draft.id, intentHash: draft.intentHash,
        to: draft.to, cc: draft.cc, bcc: draft.bcc,
        subject: draft.subject, body: draft.body,
        ...(draft.threadId ? { threadId: draft.threadId } : {}),
        ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
        ...(draft.references ? { references: draft.references } : {}),
      };
    },
    async validateSend(input) {
      const draft = normalizeDraft(input);
      const stored = await storage.getGmailDraft(input.draftId, ownerId);
      if (!stored || input.intentHash !== stored.intentHash || draftIntentHash(draft) !== stored.intentHash)
        throw Object.assign(new Error("The Gmail send intent no longer matches its immutable draft."), { code: "gmail_send_intent_mismatch", statusCode: 409 });
      return stored;
    },
    async send(input, context = {}) {
      const draft = await this.validateSend(input);
      const intentId = `gmail_send_${digest(`${draft.id}:${draft.intentHash}`)}`;
      const messageId = `${intentId}@nova.local`;
      const claim = await storage.claimGmailSendIntent({ id: intentId, ownerId, draftId: draft.id, intentHash: draft.intentHash, messageId });
      if (!claim.inserted) {
        if (claim.intent.status === "sent") return { sent: true, idempotent: true, messageId: claim.intent.providerMessageId, threadId: claim.intent.providerThreadId };
        throw new GmailError("This email send is already in progress or has an uncertain outcome; Nova will not send it again automatically.", { code: "gmail_send_not_retryable", statusCode: 409, category: "idempotency" });
      }
      try {
        const result = await gmailJson("/messages/send", {
          method: "POST",
          body: JSON.stringify({ raw: buildRawEmail(draft, { from: gmail.accountEmail, messageId }), ...(draft.threadId ? { threadId: draft.threadId } : {}) }),
        }, "send");
        const sent = await storage.updateGmailSendIntent(intentId, ownerId, { status: "sent", providerMessageId: result.id || null, providerThreadId: result.threadId || null });
        await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: "gmail_send_completed", tool: "gmail_send", status: "completed", summary: "Sent the owner-approved Gmail message.", metadata: { sendIntentId: intentId, draftId: draft.id, recipientCount: draft.to.length + draft.cc.length + draft.bcc.length } });
        return { sent: true, idempotent: false, messageId: sent.providerMessageId, threadId: sent.providerThreadId };
      } catch (error) {
        const uncertain = error?.category === "network" || error?.statusCode >= 500;
        await storage.updateGmailSendIntent(intentId, ownerId, { status: uncertain ? "uncertain" : "failed", errorCode: error?.code || "gmail_send_failed" });
        throw error;
      }
    },
  });
}
