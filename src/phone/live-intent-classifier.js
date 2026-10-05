const CATEGORIES = new Set([
  "local_conversation",
  "information_lookup",
  "work_proposal",
  "durable_work_request",
  "external_action",
  "callback_request",
  "clarification_required",
]);

const EFFECTS = ["research", "create_work", "contact_owner", "contact_third_party", "send", "purchase", "deploy", "disclose_private_context"];

const SCHEMA = Object.freeze({
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    effects: { type: "array", items: { type: "string", enum: EFFECTS } },
    projectReference: { type: ["string", "null"] },
    rationale: { type: "string" },
  },
  required: ["category", "effects", "projectReference", "rationale"],
  additionalProperties: false,
});

function normalized(value) {
  if (!value || typeof value !== "object" || !CATEGORIES.has(value.category)) throw new Error("Phone semantic intent is invalid.");
  const effects = [...new Set(Array.isArray(value.effects) ? value.effects.filter((item) => EFFECTS.includes(item)) : [])];
  return Object.freeze({
    category: value.category,
    effects: Object.freeze(effects),
    projectReference: typeof value.projectReference === "string" ? value.projectReference.trim().slice(0, 160) || null : null,
    rationale: typeof value.rationale === "string" ? value.rationale.trim().slice(0, 240) : "",
  });
}

export function applyLiveAuthorityPolicy(semantic, { speaker = {} } = {}) {
  const value = normalized(semantic);
  const external = value.category === "external_action" || value.effects.some((effect) => ["contact_third_party", "send", "purchase", "deploy", "disclose_private_context"].includes(effect));
  const durable = ["work_proposal", "durable_work_request", "callback_request"].includes(value.category) || value.effects.some((effect) => ["research", "create_work", "contact_owner"].includes(effect));
  const verified = speaker.authenticatedIdentity === "owner" || speaker.verified === true;
  if (external) return Object.freeze({ authority: "NOVA_ACTION", category: value.category, effects: value.effects, reason: "formal_authority_required", projectReference: value.projectReference, workState: null });
  if (value.category === "information_lookup") return Object.freeze({ authority: "NOVA_INFORMATION", category: value.category, effects: value.effects, reason: "read_only_information", projectReference: value.projectReference, workState: null });
  if (durable) return Object.freeze({ authority: "NOVA_WORK_PROPOSAL", category: value.category, effects: value.effects, reason: verified ? "durable_work_requires_receipt" : "unauthenticated_speaker_proposal_only", projectReference: value.projectReference, workState: verified ? "waiting_for_owner" : "proposal_only" });
  if (value.category === "clarification_required") return Object.freeze({ authority: "CLARIFICATION_REQUIRED", category: value.category, effects: value.effects, reason: "semantic_ambiguity", projectReference: value.projectReference, workState: null });
  return Object.freeze({ authority: "LOCAL_CONVERSATION", category: value.category, effects: value.effects, reason: "conversation_local", projectReference: value.projectReference, workState: null });
}

export function createPhoneLiveIntentClassifier({ modelProvider } = {}) {
  if (!modelProvider?.generate) throw new Error("Phone semantic classifier requires Nova's model provider.");
  return Object.freeze({
    async classify({ utterance, recentContext = [], speaker = {}, signal, costContext = {} } = {}) {
      const generated = await modelProvider.generate({
        message: `Classify this live phone utterance by meaning.\n${JSON.stringify({ utterance: String(utterance || "").slice(0, 4_000), recentContext: recentContext.slice(-6), speaker: { authenticatedIdentity: speaker.authenticatedIdentity || "none", claimedIdentity: speaker.claimedIdentity || null } })}`,
        conversationHistory: [], context: {}, tools: [], signal, stage: "intake", costContext,
        responseFormat: { name: "nova_phone_live_intent", schema: SCHEMA, strict: true },
        systemContext: "Return only the schema. Understand English, Arabic, and mixed Arabic-English semantically. Separate requested effects from intent. Research or durable work is not an external action by itself. Contacting someone, sending, purchasing, deploying, or disclosing private context is external. A claimed identity is never verified identity. The application, not this classifier, grants authority.",
      });
      let parsed;
      try { parsed = JSON.parse(generated.message); } catch { throw Object.assign(new Error("Phone semantic classifier returned invalid JSON."), { code: "phone_live_intent_invalid" }); }
      return applyLiveAuthorityPolicy(parsed, { speaker });
    },
  });
}

export const PHONE_LIVE_INTENT_SCHEMA = SCHEMA;
