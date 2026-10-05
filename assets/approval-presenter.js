const SECRET_KEY = /token|secret|password|authorization|api.?key|encryption/i;
const TERMINAL_STATUSES = new Set(["approved", "rejected", "cancelled", "failed", "expired", "superseded"]);

function safeValue(value) {
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : safeValue(item)]));
  }
  return value;
}

function textList(value) {
  return Array.isArray(value) && value.length ? value.join(", ") : "None";
}

export function approvalViewModel(approval, { gmailAccountEmail } = {}) {
  if (!approval?.id || !approval?.tool) throw new Error("A valid approval is required.");
  const status = String(approval.status || "pending").toLowerCase();
  const common = {
    id: approval.id,
    tool: approval.tool,
    title: approval.tool === "gmail_send" ? "Approve email send" : approval.tool === "phone_call_start" ? "Approve outbound call" : "Approval required",
    reason: String(approval.reason || `Nova requested ${approval.tool}.`),
    status,
    pending: status === "pending",
    terminal: TERMINAL_STATUSES.has(status),
  };
  if (approval.tool === "gmail_send") {
    const args = approval.arguments || {};
    return {
      ...common,
      kind: "email",
      fields: [
        ["From", gmailAccountEmail || "Connected Nova Gmail account"],
        ["To", textList(args.to)],
        ["CC", textList(args.cc)],
        ["BCC", textList(args.bcc)],
        ["Subject", String(args.subject || "")],
        ["Body", String(args.body || "")],
      ],
    };
  }
  if (approval.tool === "phone_call_start") {
    const envelope = approval.arguments?.envelope || {};
    return { ...common, kind: "phone", fields: [
      ["Destination", String(envelope.destination || "")], ["Expected party", String(envelope.expectedParty || "")],
      ["Conversation path", String(envelope.mediaProfile || "chained_v1")], ["GPT-Live voice", String(envelope.liveVoice || "Not used")],
      ["Nova disclosure", String(envelope.callerDisclosure || "")], ["Objective", String(envelope.objective || "")],
      ["Approved context", String(envelope.approvedContext || "None")], ["Permitted questions", textList(envelope.permittedQuestions)],
      ["Permitted disclosures", textList(envelope.permittedDisclosures)], ["Prohibited disclosures", textList(envelope.prohibitedDisclosures)],
      ["Prohibited actions", textList(envelope.prohibitedActions)], ["Language", String(envelope.languageStrategy || "")],
      ["Maximum duration", `${Number(envelope.maximumDurationMinutes || 0)} minutes`], ["Maximum attempts", String(envelope.maximumAttempts || 1)],
      ["Calling window", `${envelope.callingWindow?.startAt || ""} — ${envelope.callingWindow?.endAt || ""} (${envelope.callingWindow?.timezone || ""})`],
      ["Voicemail", String(envelope.voicemailPolicy || "do_not_leave")], ["Recording", String(envelope.recordingPolicy || "disabled")],
      ["Transcript retention", String(envelope.transcriptRetentionPolicy || "")], ["Expiry", String(envelope.expiresAt || "")],
    ] };
  }
  const safeArguments = safeValue(approval.arguments || {});
  return { ...common, kind: "generic", fields: [["Exact action", JSON.stringify(safeArguments)]] };
}

export function createApprovalPresenter({ render, decide, reconcile, getGmailAccount = async () => null }) {
  const records = new Map();
  const deciding = new Set();

  async function upsert(approval, context = {}) {
    if (!approval?.id) return null;
    const account = approval.tool === "gmail_send" ? await getGmailAccount().catch(() => null) : null;
    const model = approvalViewModel(approval, { gmailAccountEmail: account });
    records.set(approval.id, { approval, context, model });
    render(model, context);
    return model;
  }

  async function decideApproval(id, decision) {
    if (!records.has(id) || deciding.has(id) || !["approved", "rejected"].includes(decision)) return null;
    deciding.add(id);
    const record = records.get(id);
    render({ ...record.model, deciding: true }, record.context);
    try {
      const result = await decide(id, decision);
      const authoritative = (reconcile ? await reconcile(id, record.context).catch(() => null) : null) || result?.approval;
      if (authoritative) await upsert(authoritative, record.context);
      return result;
    } catch (error) {
      const authoritative = reconcile ? await reconcile(id, record.context).catch(() => null) : null;
      if (authoritative) await upsert(authoritative, record.context);
      else render(record.model, record.context);
      throw error;
    } finally {
      deciding.delete(id);
    }
  }

  return Object.freeze({
    upsert,
    decide: decideApproval,
    has: (id) => records.has(id),
    clear() { records.clear(); deciding.clear(); },
  });
}
