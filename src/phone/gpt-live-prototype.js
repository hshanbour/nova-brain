const LIVE_MODEL = "gpt-live-1";
const AUDIO_FORMAT = Object.freeze({ type: "audio/pcmu", rate: 8_000 });
const DEFAULT_VOICE = "marin";
const MAX_HISTORY_MESSAGES = 128;
const MAX_HISTORY_TOKENS_APPROX = 8_192;
const MAX_AUDIT_EVENTS = 2_000;
const CONSEQUENTIAL_REQUEST = /\b(?:send|approve|purchase|buy|pay|book|deploy|ship|call)\b|(?:ابعث|أرسل|ارسل|وافق|اشتري|ادفع|احجز|انشر|اتصل)/iu;

const LIVE_INSTRUCTIONS = `${NOVA_COMMUNICATION_POLICY}\n\nPHONE PRESENTATION OVERLAY: Speak naturally, directly, and concisely in the caller's language, including Jordanian/Levantine Arabic, English, and mixed Arabic-English. Maintain one continuous conversation, remember corrections and references, and do not repeat introductions or disclosures after they have already happened. Listen through incomplete thoughts and thinking pauses. Use brief natural acknowledgements only when contextually useful. You may ask an immediate clarification when continuing without it would materially misunderstand the caller, but do not interrupt merely to appear human; if the caller resumes, yield immediately.

You control conversational timing and presentation only.

Backend capabilities: Nova Brain owns durable memory, owner and business context, projects, Codex/work status, Gmail, tools, workflows, approvals, and external facts.
Delegate to the application before answering any request that depends on those capabilities. You may acknowledge naturally while waiting, but do not invent or imply the result.
Do not delegate greetings, conversation-local clarifications, or facts already established in this live conversation.

Never claim an external action succeeded until the application returns a verified result. Spoken approval is non-authoritative. Consequential actions require Nova's existing formal approval system outside this live layer.`;

function approximateTokens(value) {
  return Math.ceil(String(value || "").length / 4);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) throw new TypeError("GPT-Live history must be an array.");
  const selected = [];
  let tokens = 0;
  for (const entry of history.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    if (!entry || !["developer", "user", "assistant"].includes(entry.role) || typeof entry.content !== "string") continue;
    const content = entry.content.trim();
    if (!content) continue;
    const next = approximateTokens(content);
    if (tokens + next > MAX_HISTORY_TOKENS_APPROX) break;
    selected.unshift({
      type: "message",
      role: entry.role,
      content: [{ type: entry.role === "assistant" ? "output_text" : "input_text", text: content }],
    });
    tokens += next;
  }
  return selected;
}

export function buildGptLivePrototypeSession({ voice = DEFAULT_VOICE, history = [] } = {}) {
  if (!/^[a-z][a-z0-9_-]{1,63}$/i.test(voice)) throw new TypeError("GPT-Live voice name is invalid.");
  return Object.freeze({
    model: LIVE_MODEL,
    instructions: LIVE_INSTRUCTIONS,
    input: Object.freeze(normalizeHistory(history)),
    audio: Object.freeze({ format: AUDIO_FORMAT, output: Object.freeze({ voice }) }),
    delegation: Object.freeze({ type: "client" }),
    store: false,
  });
}

function safeProviderError(event) {
  const type = String(event?.error?.type || "provider_error").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
  const code = String(event?.error?.code || "unknown").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
  return Object.assign(new Error(`GPT-Live provider error (${type}:${code}).`), { code: "gpt_live_provider_error", providerCategory: `${type}:${code}` });
}

export function createGptLivePrototypeController({
  send,
  delegate,
  onAudio = () => {},
  onClearAudio = () => {},
  clock = () => performance.now(),
  idFactory = () => globalThis.crypto.randomUUID(),
  maxAuditEvents = MAX_AUDIT_EVENTS,
} = {}) {
  if (typeof send !== "function" || typeof delegate !== "function") throw new TypeError("GPT-Live send and delegate callbacks are required.");
  let state = "idle";
  let sessionId = null;
  let callerSpeaking = false;
  let assistantSpeaking = false;
  let inputTranscript = "";
  let currentInputTranscript = "";
  let outputTranscript = "";
  let revision = 0;
  let firstInputAt = null;
  let firstAudioAt = null;
  let usageSeconds = 0;
  let callerInterruptions = 0;
  let assistantInterruptions = 0;
  let duplicates = 0;
  const startedAt = clock();
  const seenEvents = new Set();
  const delegations = new Map();
  const audit = [];

  const record = (type, fields = {}) => {
    if (audit.length >= maxAuditEvents) audit.shift();
    audit.push(Object.freeze({ sequence: audit.length ? audit.at(-1).sequence + 1 : 1, atMs: Math.max(0, Math.round(clock() - startedAt)), type, ...fields }));
  };
  const emit = (event) => send(Object.freeze(event));
  const eventSeen = (event) => {
    if (!event?.event_id) return false;
    if (seenEvents.has(event.event_id)) { duplicates += 1; return true; }
    seenEvents.add(event.event_id);
    return false;
  };

  const cancelRunningDelegations = (reason) => {
    const running = [...delegations.values()].filter((task) => task.status === "running");
    if (!running.length) return false;
    revision += 1;
    for (const task of running) {
      task.status = "cancelled";
      task.controller.abort();
      record("delegation_cancelled", { delegationId: task.id, reason });
    }
    return true;
  };

  async function runDelegation(event) {
    const delegationId = event?.delegation?.id;
    if (!delegationId || delegations.has(delegationId)) return false;
    const controller = new AbortController();
    const task = { id: delegationId, revision, status: "running", controller };
    delegations.set(delegationId, task);
    const request = currentInputTranscript.trim() || inputTranscript.trim();
    record("delegation_started", { delegationId, requestRevision: revision });
    try {
      const result = CONSEQUENTIAL_REQUEST.test(request)
        ? { message: "This request requires Nova's existing formal approval flow. Spoken approval cannot authorize it.", approvalRequired: true }
        : await delegate({ delegationId, transcript: request, revision, signal: controller.signal });
      if (task.status !== "running" || task.revision !== revision || controller.signal.aborted) {
        record("delegation_result_discarded", { delegationId, reason: "stale_or_cancelled" });
        return false;
      }
      const content = String(result?.message || "").trim().slice(0, 2_000);
      if (!content) throw Object.assign(new Error("Nova delegation returned no safe result."), { code: "gpt_live_delegation_empty" });
      task.status = result?.approvalRequired ? "waiting_for_approval" : "completed";
      emit({ type: "session.commentary.append", event_id: idFactory(), delegation_id: delegationId, content });
      record("delegation_completed", { delegationId, status: task.status });
      return true;
    } catch (error) {
      if (controller.signal.aborted || task.status === "cancelled") return false;
      task.status = "failed";
      emit({ type: "session.commentary.append", event_id: idFactory(), delegation_id: delegationId, content: "Nova could not verify that result safely. No action was taken." });
      record("delegation_failed", { delegationId, category: String(error?.code || "delegation_failed").slice(0, 80) });
      return false;
    }
  }

  return Object.freeze({
    start(options = {}) {
      if (state !== "idle") return false;
      state = "connecting";
      emit({ type: "session.start", event_id: idFactory(), session: buildGptLivePrototypeSession(options) });
      record("session_start_requested");
      return true;
    },
    appendAudio(audio) {
      if (state !== "active" || !Buffer.isBuffer(audio) || audio.length === 0) return false;
      if (firstInputAt === null) firstInputAt = clock();
      emit({ type: "session.input_audio.append", event_id: idFactory(), audio: audio.toString("base64") });
      return true;
    },
    callerSpeechStarted() {
      if (state !== "active") return false;
      if (!callerSpeaking) currentInputTranscript = "";
      callerSpeaking = true;
      record("caller_speech_started");
      cancelRunningDelegations("caller_correction");
      if (assistantSpeaking) {
        callerInterruptions += 1;
        assistantSpeaking = false;
        onClearAudio();
        record("assistant_output_interrupted", { by: "caller" });
      }
      return true;
    },
    callerSpeechEnded() {
      if (!callerSpeaking) return false;
      callerSpeaking = false;
      record("caller_speech_ended");
      return true;
    },
    correctRunningDelegations() {
      return cancelRunningDelegations("caller_correction");
    },
    async handleServerEvent(event) {
      if (!event || typeof event.type !== "string" || eventSeen(event)) return false;
      if (event.type === "session.started") {
        state = "active";
        sessionId = event.session?.id || null;
        record("session_started");
        return true;
      }
      if (event.type === "session.input_transcript.delta") {
        const delta = String(event.delta || "");
        inputTranscript += delta;
        currentInputTranscript += delta;
        record("caller_transcript_delta", { text: String(event.delta || ""), startMs: event.start_ms ?? null, endMs: event.end_ms ?? null });
        return true;
      }
      if (event.type === "session.output_transcript.delta") {
        outputTranscript += String(event.delta || "");
        record("nova_transcript_delta", { text: String(event.delta || ""), startMs: event.start_ms ?? null, endMs: event.end_ms ?? null });
        return true;
      }
      if (event.type === "session.output_audio.delta") {
        if (!assistantSpeaking && callerSpeaking) assistantInterruptions += 1;
        assistantSpeaking = true;
        if (firstAudioAt === null) firstAudioAt = clock();
        const audio = Buffer.from(String(event.delta || ""), "base64");
        if (audio.length) onAudio(audio);
        return true;
      }
      if (event.type === "session.delegation.created") return runDelegation(event);
      if (event.type === "session.usage.updated") {
        usageSeconds = Math.max(usageSeconds, Number(event.usage?.seconds) || 0);
        return true;
      }
      if (event.type === "session.closed") {
        usageSeconds = Math.max(usageSeconds, Number(event.usage?.seconds) || 0);
        state = "closed";
        assistantSpeaking = false;
        record("session_closed", { usageSeconds });
        return true;
      }
      if (event.type === "error") throw safeProviderError(event);
      return false;
    },
    close() {
      if (state === "closed" || state === "closing" || state === "idle") return false;
      state = "closing";
      for (const task of delegations.values()) if (task.status === "running") { task.status = "cancelled"; task.controller.abort(); }
      emit({ type: "session.close", event_id: idFactory() });
      record("session_close_requested");
      return true;
    },
    snapshot() {
      return Object.freeze({
        state,
        sessionId,
        callerSpeaking,
        assistantSpeaking,
        inputTranscript,
        currentInputTranscript,
        outputTranscript,
        revision,
        usageSeconds,
        firstAudioMs: firstAudioAt === null || firstInputAt === null ? null : Math.round(firstAudioAt - firstInputAt),
        callerInterruptions,
        assistantInterruptions,
        duplicates,
        delegations: Object.freeze([...delegations.values()].map(({ id, status, revision: requestRevision }) => Object.freeze({ id, status, requestRevision }))),
        rawAudioPersisted: false,
        audit: Object.freeze([...audit]),
      });
    },
  });
}

export const GPT_LIVE_PROTOTYPE_CONTRACT = Object.freeze({
  model: LIVE_MODEL,
  audioFormat: AUDIO_FORMAT,
  delegation: "client",
  store: false,
  authority: "nova_brain",
  rawAudioPersisted: false,
});
import { NOVA_COMMUNICATION_POLICY } from "../identity/communication-policy.js";
