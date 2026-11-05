import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCallEnvelope } from "../src/phone/call-envelope.js";
import { buildPhoneCallSystemContext } from "../src/memory/context-retriever.js";
import { buildSalesGuidance } from "../src/phone/sales-policy.js";

const base = () => ({
  destination: "+447700900123",
  expectedParty: "A UK business owner",
  callerDisclosure: "Nova, an AI assistant calling for Nova Digital Services UK.",
  objective: "Understand the business's missed-call problem and, if relevant, request a discovery meeting.",
  approvedContext: "Only the approved missed-call recovery service may be discussed. No price has been approved.",
  permittedQuestions: ["How are missed calls handled today?", "Would a discovery meeting be useful?"],
  permittedDisclosures: ["Nova is an AI assistant."],
  prohibitedDisclosures: ["Unapproved prices", "Fabricated customer results"],
  prohibitedActions: ["Take payment", "Sign a contract", "Ignore a refusal"],
  approvedNextSteps: ["Request a discovery meeting", "Offer owner follow-up"],
  maximumDurationMinutes: 5,
  callingWindow: { timezone: "Europe/London", startAt: "2026-11-05T10:00:00.000Z", endAt: "2026-11-05T11:00:00.000Z" },
  expiresAt: "2026-11-05T12:00:00.000Z",
});

test("all three sales styles remain bounded by truthful pricing, refusal, and approval rules", () => {
  for (const salesStyle of ["consultative", "balanced", "assertive"]) {
    const envelope = normalizeCallEnvelope({ ...base(), salesStyle }, { now: new Date("2026-11-05T09:00:00.000Z") });
    const prompt = buildPhoneCallSystemContext(envelope);
    assert.match(prompt, new RegExp(`APPROVED SALES STYLE \\(${salesStyle}\\)`));
    assert.match(prompt, /Never fabricate scarcity, savings, customers, results, authority or pricing/);
    assert.match(prompt, /Never pressure after a refusal/);
    assert.match(prompt, /formal approval boundary/);
    assert.match(prompt, /Request a discovery meeting/);
  }
});

test("assertive style is proactive but cannot harass or turn a follow-up into a sale", () => {
  const guidance = buildSalesGuidance("assertive");
  assert.match(guidance, /ask directly/);
  assert.match(guidance, /accept any refusal immediately/);
  assert.match(guidance, /is not a sale/);
});

test("unrecognised sales style fails closed", () => {
  assert.throws(() => normalizeCallEnvelope({ ...base(), salesStyle: "relentless" }, { now: new Date("2026-11-05T09:00:00.000Z") }), /sales conversation style is invalid/);
});
