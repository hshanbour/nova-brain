const PARTIAL = new Set(["partially_delivered", "interrupted", "truncated"]);
const UNHEARD = new Set(["cleared", "not_delivered", "cleared_unheard", "generated_not_released"]);

function latestBy(items, key) {
  const result = new Map();
  for (const item of items) result.set(key(item), item);
  return [...result.values()];
}

export function projectCallTimeline(messages = [], events = []) {
  const callerById = new Map(messages.filter((item) => item.role === "user").map((item) => [item.id, item]));
  const turns = events.filter((item) => item.eventType === "authority_classified");
  const deliveries = latestBy(
    events.filter((item) => item.eventType === "assistant_output_delivery"),
    (item) => `${item.turnId}:${item.metadata?.outputKind || "final"}`,
  );
  const timeline = [];
  for (const item of turns) {
    const message = callerById.get(item.metadata?.userMessageId);
    if (message) timeline.push({ id: message.id, turnId: item.turnId, role: "user", content: message.content, status: "confirmed", createdAt: message.createdAt, speaker: item.metadata?.speaker || null });
  }
  for (const item of deliveries) {
    const content = String(item.metadata?.deliveredText || "").trim();
    timeline.push({
      id: item.messageId || item.id,
      turnId: item.turnId,
      role: "assistant",
      content,
      status: item.status,
      outputKind: item.metadata?.outputKind || "final",
      heard: Boolean(content),
      createdAt: item.createdAt,
      checkpoints: item.metadata?.checkpoints || [],
    });
  }
  return timeline.sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || String(left.id).localeCompare(String(right.id)));
}

export function summarizeCall(outcome, events = [], messages = []) {
  const timeline = projectCallTimeline(messages, events);
  const counts = { caller: 0, acknowledgements: 0, delivered: 0, partial: 0, cleared: 0, superseded: 0, novaRuns: 0 };
  counts.caller = events.filter((item) => item.eventType === "authority_classified").length;
  counts.acknowledgements = timeline.filter((item) => item.role === "assistant" && item.outputKind === "acknowledgement" && item.heard).length;
  counts.delivered = timeline.filter((item) => item.role === "assistant" && item.outputKind !== "acknowledgement" && item.status === "delivered").length;
  counts.partial = timeline.filter((item) => item.role === "assistant" && PARTIAL.has(item.status)).length;
  counts.cleared = timeline.filter((item) => item.role === "assistant" && UNHEARD.has(item.status)).length;
  counts.superseded = events.filter((item) => item.eventType === "backend_work_superseded" || (item.eventType === "assistant_output_delivery" && item.status === "superseded_before_generation")).length;
  counts.novaRuns = events.filter((item) => item.eventType === "nova_result_reintegrated").length;
  return { counts, text: `${outcome || "Call ended"}. ${counts.caller} caller turn(s), ${counts.acknowledgements} acknowledgement(s), ${counts.delivered} delivered answer(s), ${counts.partial} partial/interrupted, ${counts.cleared} cleared/unheard, ${counts.superseded} superseded, ${counts.novaRuns} Nova run(s).` };
}
