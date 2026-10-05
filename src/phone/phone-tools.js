import { RISK_LEVELS } from "../policy/action-policy.js";

export function registerPhoneTools(registry, { service }) {
  const common = { category: "phone", available: service.configured, configurationStatus: service.configured ? "ready" : "configuration_required" };
  registry.register({
    ...common, name: "phone_call_prepare", description: "Prepare one immutable UK outbound-call envelope without dialing.", riskLevel: RISK_LEVELS.LOW_RISK_WRITE, autonomous: true,
    inputSchema: { type: "object", properties: { destination: { type: "string" }, expectedParty: { type: "string" }, callerDisclosure: { type: "string" }, objective: { type: "string" }, approvedContext: { type: "string" }, permittedQuestions: { type: "array" }, permittedDisclosures: { type: "array" }, prohibitedDisclosures: { type: "array" }, prohibitedActions: { type: "array" }, languageStrategy: { type: "string" }, maximumDurationMinutes: { type: "number" }, maximumAttempts: { type: "number" }, callingWindow: { type: "object" }, voicemailPolicy: { type: "string" }, approvedVoicemailMessage: { type: "string" }, recordingPolicy: { type: "string" }, terminationBehavior: { type: "string" }, mediaProfile: { type: "string", enum: ["chained_v1", "gpt_live_round2_preview"] }, liveVoice: { type: "string", enum: ["marin", "willow", "gleam"] }, expiresAt: { type: "string" } }, required: ["destination", "expectedParty", "callerDisclosure", "objective", "maximumDurationMinutes", "expiresAt"], additionalProperties: false },
    execute: (input, context) => service.prepare(input, context),
  });
  registry.register({ ...common, name: "phone_call_current", description: "Resolve the latest exact prepared outbound call in this conversation.", riskLevel: RISK_LEVELS.READ_ONLY, inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: (input, context) => service.current(input, context) });
  registry.register({
    ...common, name: "phone_call_start", description: "Start one exact immutable prepared call. Always requires formal owner approval and has one dial attempt.", riskLevel: RISK_LEVELS.SENSITIVE, approvalReason: "Place this exact outbound phone call within the immutable approved envelope.",
    inputSchema: { type: "object", properties: { callIntentId: { type: "string" }, envelopeHash: { type: "string" }, envelope: { type: "object" } }, required: ["callIntentId", "envelopeHash", "envelope"], additionalProperties: false },
    validate: (input, context) => service.validateStart(input, context),
    onApprovalRequired: (input, approval, context) => service.approvalRequired(input, approval, context),
    onApprovalDecision: (approval, decision) => service.approvalDecision(approval, decision),
    execute: (input, context) => service.start(input, context),
  });
}
