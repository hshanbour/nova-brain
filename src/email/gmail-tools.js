import { RISK_LEVELS } from "../policy/action-policy.js";

const draftProperties = {
  to: { type: "array" }, cc: { type: "array" }, bcc: { type: "array" },
  subject: { type: "string" }, body: { type: "string" },
  threadId: { type: "string" }, inReplyTo: { type: "string" }, references: { type: "string" },
};

export function registerGmailTools(registry, { service }) {
  const available = service.configured;
  const common = { category: "email", available, configurationStatus: available ? "ready" : "configuration_required" };
  registry.register({
    ...common, name: "gmail_search", description: "Search the owner's connected Gmail mailbox using Gmail search syntax.", riskLevel: RISK_LEVELS.READ_ONLY,
    inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"], additionalProperties: false },
    execute: (input, context) => service.search(input, context),
  });
  registry.register({
    ...common, name: "gmail_thread_read", description: "Read one exact thread from the owner's connected Gmail mailbox.", riskLevel: RISK_LEVELS.READ_ONLY,
    inputSchema: { type: "object", properties: { threadId: { type: "string" } }, required: ["threadId"], additionalProperties: false },
    execute: (input, context) => service.readThread(input, context),
  });
  registry.register({
    ...common, name: "gmail_draft_prepare", description: "Prepare an internal Nova email or reply draft without sending it.", riskLevel: RISK_LEVELS.LOW_RISK_WRITE, autonomous: true,
    inputSchema: { type: "object", properties: draftProperties, required: ["to", "subject", "body"], additionalProperties: false },
    execute: (input, context) => service.prepareDraft(input, context),
  });
  registry.register({
    ...common, name: "gmail_draft_current", description: "Resolve the one exact internal Nova email draft previously prepared in this authenticated conversation. Use this before gmail_send when the owner says send it, send this email, or send the draft. Never search Gmail or reconstruct the email instead.", riskLevel: RISK_LEVELS.READ_ONLY,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: (input, context) => service.currentDraft(input, context),
  });
  registry.register({
    ...common, name: "gmail_send", description: "Send one exact immutable internal Nova draft through Gmail. Always requires explicit owner approval.", riskLevel: RISK_LEVELS.SENSITIVE,
    approvalReason: "Send this exact email through Nova's connected Gmail mailbox.",
    inputSchema: { type: "object", properties: { draftId: { type: "string" }, intentHash: { type: "string" }, ...draftProperties }, required: ["draftId", "intentHash", "to", "cc", "bcc", "subject", "body"], additionalProperties: false },
    validate: (input) => service.validateSend(input),
    execute: (input, context) => service.send(input, context),
  });
}
