import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NOVA_COMMUNICATION_POLICY } from "../identity/communication-policy.js";

export const LIVE_AUTHORITY = Object.freeze({
  LOCAL_CONVERSATION: "LOCAL_CONVERSATION",
  NOVA_INFORMATION: "NOVA_INFORMATION",
  NOVA_ACTION: "NOVA_ACTION",
  CLARIFICATION_REQUIRED: "CLARIFICATION_REQUIRED",
});

const ACTION = /\b(?:send|call|dial|buy|purchase|pay|book|deploy|ship|delete|approve|reject)\b|(?:ابعث|أرسل|ارسل|اتصل|اشتري|ادفع|احجز|انشر|احذف|وافق|ارفض)/iu;
const INFORMATION = /\b(?:sharp\s*cuts|codex|project|deployment|preview|gmail|email|business|customer|task|workflow|memory|status)\b|(?:شارب\s*كتس|كودكس|مشروع|مشاريع|نشر|إيميل|ايميل|عمل|أعمال|زبون|مهمة|ذاكرة|شو صار|آخر إشي)/iu;
const AMBIGUOUS = /^(?:it|that|this|them|do it|go ahead|what about it|شو|هاي|هذا|هيك|اعملها|سويها|كملها)\??$/iu;
const MAX_TEXT = 8_000;

function text(value, field, max = MAX_TEXT) {
  const result = String(value || "").trim();
  if (!result || result.length > max) throw Object.assign(new Error(`${field} is invalid.`), { code: "gpt_live_round2_invalid" });
  return result;
}
function stableId(prefix, conversationId, turnId, suffix) {
  return `${prefix}_${createHash("sha256").update(`${conversationId}:${turnId}:${suffix}`).digest("hex").slice(0, 32)}`;
}
function safeState(value = {}) {
  const unresolvedTopic = typeof value.unresolvedTopic === "string" ? value.unresolvedTopic.slice(0, 500) : null;
  return { unresolvedTopic, pendingAuthority: value.pendingAuthority || null, lastTurnId: value.lastTurnId || null, generationStatus: value.generationStatus || null };
}

function supersededError() {
  return Object.assign(new DOMException("Superseded by a newer live turn.", "AbortError"), { code: "gpt_live_round2_superseded" });
}

export function classifyLiveAuthority(utterance, { unresolvedState = {} } = {}) {
  const value = text(utterance, "utterance", 4_000);
  if (ACTION.test(value)) return Object.freeze({ authority: LIVE_AUTHORITY.NOVA_ACTION, reason: "consequential_or_external_action" });
  if (INFORMATION.test(value)) return Object.freeze({ authority: LIVE_AUTHORITY.NOVA_INFORMATION, reason: "nova_owned_information" });
  if (AMBIGUOUS.test(value) && !unresolvedState?.unresolvedTopic) return Object.freeze({ authority: LIVE_AUTHORITY.CLARIFICATION_REQUIRED, reason: "missing_local_referent" });
  return Object.freeze({ authority: LIVE_AUTHORITY.LOCAL_CONVERSATION, reason: "conversation_local" });
}

export const GPT_LIVE_PHONE_GUIDANCE = `PHONE PRESENTATION OVERLAY: Keep spoken answers concise and natural. Use contemporary Jordanian/Levantine Arabic with Mohammad, preserve useful English product and technical names, yield immediately on interruption, and ask one brief clarification only when necessary. Never invent filler. This overlay changes presentation only; Nova's shared policy and application authority remain controlling.`;

export function buildRound2LiveInstructions() {
  return `${NOVA_COMMUNICATION_POLICY}\n\n${GPT_LIVE_PHONE_GUIDANCE}\n\nAUTHORITY: Application decisions are deterministic. Do not speak buffered output until the application releases it. Project, business, email, Codex, memory, workflow, and external facts require NOVA_INFORMATION. Actions require NOVA_ACTION and formal UI approval; spoken approval is never authoritative. For NOVA_INFORMATION, before verified commentary arrives you may give only one brief, natural acknowledgement that you are checking; add no fact, number, result, status, completion claim, or external action. When verified commentary arrives, present only that verified result naturally and concisely.`;
}

export function createRound2Authorization(secret) {
  const expected = createHash("sha256").update(String(secret || "")).digest();
  return (request) => {
    if (!secret) return false;
    const supplied = createHash("sha256").update(String(request?.headers?.["x-nova-round2-authorization"] || "")).digest();
    return timingSafeEqual(expected, supplied);
  };
}

export function createGptLiveRound2Service({ storage, ownerId, novaTurn, clock = () => new Date(), idFactory = randomUUID } = {}) {
  if (!storage || !ownerId || typeof novaTurn !== "function") throw new Error("Round 2 requires storage, owner identity, and Nova Brain.");
  async function stateFor(conversationId) {
    const value = await storage.getLiveConversationState(conversationId, ownerId);
    if (!value) throw Object.assign(new Error("Canonical live conversation is unavailable."), { code: "gpt_live_round2_conversation_missing" });
    return value;
  }
  async function event(input) {
    return storage.appendConversationEvent({ ownerId, ...input });
  }
  async function advance(conversationId, current, patch) {
    return storage.updateLiveConversationState(conversationId, ownerId, { ...patch, expectedContextVersion: current.contextVersion });
  }
  async function fenceCurrent(conversationId, turnId, contextVersion) {
    const value = await stateFor(conversationId);
    if (value.contextVersion !== contextVersion || value.unresolvedState?.lastTurnId !== turnId || value.unresolvedState?.generationStatus !== "running") throw supersededError();
  }

  return Object.freeze({
    async start({ conversationId = idFactory(), rollingSummary = "", unresolvedState = {} } = {}) {
      await storage.ensureConversation({ id: conversationId, ownerId, title: "GPT-Live non-PSTN certification" });
      const state = await storage.ensureLiveConversationState({ conversationId, ownerId, rollingSummary, unresolvedState: safeState(unresolvedState) });
      await event({ id: stableId("liveevt", conversationId, "session", "started"), conversationId, turnId: null, eventType: "live_session_started", status: "active", metadata: { protocol: "gpt-live-round2", rawAudioPersisted: false } });
      return { conversationId, contextVersion: state.contextVersion, instructions: buildRound2LiveInstructions() };
    },

    async handleTurn({ conversationId, turnId = idFactory(), utterance, localResponse, expectedContextVersion, unresolvedState } = {}) {
      const input = text(utterance, "utterance", 4_000);
      const current = await stateFor(conversationId);
      if (expectedContextVersion !== undefined && expectedContextVersion !== current.contextVersion) throw Object.assign(new Error("Live context version is stale."), { code: "gpt_live_round2_stale_context" });
      const decision = classifyLiveAuthority(input, { unresolvedState: unresolvedState || current.unresolvedState });
      const userMessageId = stableId("livemsg", conversationId, turnId, "user");
      const assistantMessageId = stableId("livemsg", conversationId, turnId, "assistant");
      await event({ id: stableId("liveevt", conversationId, turnId, "classified"), conversationId, turnId, eventType: "authority_classified", status: decision.authority, metadata: { reason: decision.reason, userMessageId } });
      if(current.unresolvedState?.generationStatus==="running"&&current.unresolvedState?.lastTurnId&&current.unresolvedState.lastTurnId!==turnId){
        await event({id:stableId("liveevt",conversationId,current.unresolvedState.lastTurnId,`superseded:${turnId}`),conversationId,turnId:current.unresolvedState.lastTurnId,eventType:"backend_work_superseded",status:"superseded",metadata:{supersedingTurnId:turnId}});
      }
      const reserved=await advance(conversationId,current,{unresolvedState:safeState({unresolvedTopic:current.unresolvedState?.unresolvedTopic,pendingAuthority:decision.authority,lastTurnId:turnId,generationStatus:"running"})});

      if (decision.authority === LIVE_AUTHORITY.NOVA_INFORMATION) {
        const recentTurns = await storage.listMessages(conversationId, ownerId, { limit: 32 });
        try {
          const result = await novaTurn({
            message: input,
            conversationId,
            userMessageId,
            assistantMessageId,
            deferConversationPersistence: true,
            commitGuard:()=>fenceCurrent(conversationId,turnId,reserved.contextVersion),
            context: { gptLiveRound2: { authority: "read_only", contextVersion: reserved.contextVersion, turnId, recentTurns: recentTurns.map(({ id, role, content, sequence }) => ({ id, role, content, sequence })), rollingSummary: current.rollingSummary, unresolvedState: current.unresolvedState, currentUtterance: input } },
          });
          await fenceCurrent(conversationId,turnId,reserved.contextVersion);
          const next = await advance(conversationId, reserved, { unresolvedState: safeState({ unresolvedTopic: input, pendingAuthority: null, lastTurnId: turnId,generationStatus:"completed" }) });
          await storage.appendMessage({id:userMessageId,conversationId,ownerId,role:"user",content:input});
          await storage.appendMessage({id:result.id||assistantMessageId,conversationId,ownerId,role:"assistant",content:result.message});
          await event({ id: stableId("liveevt", conversationId, turnId, "nova_reintegrated"), conversationId, turnId, messageId: result.id || assistantMessageId, eventType: "nova_result_reintegrated", status: "ready_to_present", metadata: { runId: result.runId || null, provider: result.provider || null, commentaryDelegationId: null } });
          return { authority: decision.authority, status: "ready_to_present", conversationId, turnId, contextVersion: next.contextVersion, message: result.message, messageId: result.id || assistantMessageId, liveEvent: { type: "session.commentary.append", delegation_id: null, content: result.message } };
        } catch (error) {
          if (["gpt_live_round2_superseded","live_context_version_conflict"].includes(error?.code) || error?.name === "AbortError") return { authority: decision.authority, status: "superseded", conversationId, turnId };
          throw error;
        }
      }

      let response;
      if (decision.authority === LIVE_AUTHORITY.NOVA_ACTION) response = "This request requires Nova's formal approval flow. Spoken approval cannot authorise it, and no action was executed.";
      else if (decision.authority === LIVE_AUTHORITY.CLARIFICATION_REQUIRED) response = text(localResponse || "Which exact item do you mean?", "localResponse", 2_000);
      else response = text(localResponse, "localResponse", 2_000);
      const next = await advance(conversationId, reserved, { unresolvedState: safeState({ unresolvedTopic: decision.authority === LIVE_AUTHORITY.CLARIFICATION_REQUIRED ? input : null, pendingAuthority: decision.authority === LIVE_AUTHORITY.NOVA_ACTION ? "formal_approval_required" : null, lastTurnId: turnId,generationStatus:"completed" }) });
      await storage.appendMessage({ id: userMessageId, conversationId, ownerId, role: "user", content: input });
      await storage.appendMessage({ id: assistantMessageId, conversationId, ownerId, role: "assistant", content: response });
      await event({ id: stableId("liveevt", conversationId, turnId, "intended"), conversationId, turnId, messageId: assistantMessageId, eventType: "assistant_output_intended", status: "buffered", metadata: { authority: decision.authority, outputGate: decision.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION || decision.authority === LIVE_AUTHORITY.CLARIFICATION_REQUIRED ? "released" : "blocked", approvalCreated: false, actionExecuted: false } });
      return { authority: decision.authority, status: decision.authority === LIVE_AUTHORITY.NOVA_ACTION ? "waiting_for_formal_approval" : "ready_to_present", conversationId, turnId, contextVersion: next.contextVersion, message: response, messageId: assistantMessageId, actionExecuted: false, approvalCreated: false };
    },

    async recordDelivery({ conversationId, turnId, messageId, intendedText, deliveredText = "", status = "delivered", replacedByTurnId = null } = {}) {
      if (!["delivered", "truncated", "replaced", "superseded"].includes(status)) throw new Error("Delivery status is invalid.");
      const intended = text(intendedText, "intendedText", 8_000);
      const delivered = String(deliveredText || "").slice(0, 8_000);
      return event({ id: stableId("liveevt", conversationId, turnId, `delivery:${status}:${messageId}`), conversationId, turnId, messageId, eventType: "assistant_output_delivery", status, metadata: { intendedText: intended, deliveredText: delivered, replacedByTurnId, heardCompletely: status === "delivered" && delivered === intended } });
    },

    async restore({ conversationId, messageLimit = 64, eventLimit = 128 } = {}) {
      const state = await stateFor(conversationId);
      const [messages, events] = await Promise.all([storage.listMessages(conversationId, ownerId, { limit: Math.min(128, messageLimit) }), storage.listConversationEvents(conversationId, ownerId, { limit: Math.min(256, eventLimit) })]);
      return { conversationId, contextVersion: state.contextVersion, rollingSummary: state.rollingSummary, unresolvedState: state.unresolvedState, messages, events, rawAudioPersisted: false };
    },

    async extractMemoryCandidates({ conversationId } = {}) {
      const [messages,events] = await Promise.all([storage.listMessages(conversationId, ownerId, { limit: 128 }),storage.listConversationEvents(conversationId,ownerId,{limit:256})]);
      const accepted = [], rejected = [];
      for (const message of messages.filter((item) => item.role === "user")) {
        const base = { source: { conversationId, messageId: message.id, sequence: message.sequence }, content: message.content };
        const classified=events.find(item=>item.eventType==="authority_classified"&&item.metadata?.userMessageId===message.id),turnEvents=classified?events.filter(item=>item.turnId===classified.turnId):[];
        const terminal=turnEvents.some(item=>item.eventType==="assistant_output_delivery"&&item.status==="delivered"&&item.metadata?.heardCompletely===true)||turnEvents.some(item=>item.eventType==="nova_result_reintegrated"&&item.status==="ready_to_present");
        const invalid=turnEvents.some(item=>["superseded","cancelled","failed","truncated","replaced"].includes(item.status));
        const interrogative=/[?؟]\s*$|^(?:what|when|where|who|why|how|is|are|do|does|did|can|could|would|شو|متى|وين|مين|ليش|كيف|هل)\b/iu.test(message.content);
        const durable=/\b(?:decided|deadline|remember|customer|project)\b|(?:قررنا|الموعد|تذكّر|احفظ|زبون|مشروع)/iu.test(message.content)&&message.content.length>=20;
        if(durable&&!interrogative&&terminal&&!invalid)accepted.push({...base,candidateType:/deadline|الموعد/iu.test(message.content)?"deadline":"verified_durable_fact",status:"dry_run"});
        else rejected.push({...base,reason:interrogative?"interrogative_not_fact":!terminal||invalid?"unverified_or_nonterminal_source":message.content.length<20?"transient_or_filler":"unverified_or_not_durable"});
      }
      return { conversationId, mode: "dry_run", writes: 0, accepted, rejected };
    },
  });
}
