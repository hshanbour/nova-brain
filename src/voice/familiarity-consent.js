import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const FAMILIARITY_CONSENT_STATEMENT = "I explicitly consent to Nova deriving and storing an encrypted anonymous voiceprint only to recognize this voice as a recurring speaker. I understand this does not verify my identity, grant permissions, or retain raw audio, and I can withdraw consent and delete the voiceprint.";

export function createFamiliarityConsent({ key, clock = Date.now, ttlMs = 4 * 60 * 60 * 1000 } = {}) {
  const secret = typeof key === "string" && key.length >= 32 ? key : null;
  const sign = (value) => createHmac("sha256", secret).update(`nova-familiarity-consent-v1.${value}`).digest("base64url");
  return Object.freeze({
    configured: Boolean(secret),
    issue({ consent, consentActor, statement, selfReportedName }) {
      if (!secret || consent !== true || statement !== FAMILIARITY_CONSENT_STATEMENT || typeof consentActor !== "string" || !consentActor.trim()) return null;
      const alias = typeof selfReportedName === "string" && selfReportedName.trim() ? selfReportedName.trim().slice(0, 80) : null;
      const payload = Buffer.from(JSON.stringify({ type: "anonymous_voice_familiarity_consent", jti: randomUUID(), consent_actor: consentActor.trim().slice(0, 120), self_reported_name: alias, exp: clock() + ttlMs })).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },
    verify(token) {
      if (!secret || typeof token !== "string") return null;
      const [payload, supplied, extra] = token.split("."); if (!payload || !supplied || extra) return null;
      const expected = sign(payload); const left = Buffer.from(supplied); const right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
      try { const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return value.type === "anonymous_voice_familiarity_consent" && value.exp >= clock() ? value : null; } catch { return null; }
    }
  });
}
