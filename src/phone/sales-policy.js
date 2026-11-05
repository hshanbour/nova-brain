export const SALES_STYLES = Object.freeze(["consultative", "balanced", "assertive"]);

export function buildSalesGuidance(style = "balanced") {
  const selected = SALES_STYLES.includes(style) ? style : "balanced";
  const approach = selected === "consultative"
    ? "Prioritise discovery, permission-based questions, and a low-pressure next step."
    : selected === "assertive"
      ? "Lead proactively, make a clear evidence-based recommendation, ask directly for the approved next step, and accept any refusal immediately."
      : "Balance discovery with a clear commercial recommendation and one confident request for the approved next step.";
  return `APPROVED SALES STYLE (${selected}): ${approach} Adapt to the other party's answers; do not read a rigid script. Identify needs before pitching, use only approved services, prices, evidence and offers, handle objections truthfully, and summarise the agreed next step. Never fabricate scarcity, savings, customers, results, authority or pricing. Never pressure after a refusal, argue with a do-not-contact request, conceal that you are an AI, or imply a contract or purchase without explicit human confirmation. A request for follow-up, a meeting, or owner review is not a sale. Every consequential next step remains subject to the immutable call envelope and Nova's formal approval boundary.`;
}
