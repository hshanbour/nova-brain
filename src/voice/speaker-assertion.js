import { createHmac, timingSafeEqual } from "node:crypto";

export function createSpeakerAssertions({ key, clock = Date.now, ttlMs = 120_000 } = {}) {
  const secret = typeof key === "string" && key.length >= 32 ? key : null;
  const sign = (value) => createHmac("sha256", secret).update(value).digest("base64url");
  return Object.freeze({
    configured: Boolean(secret),
    issue(speaker) {
      if (!secret) return null;
      const payload = Buffer.from(JSON.stringify({ speaker_profile_id: speaker.speaker_profile_id || null, speaker_label: speaker.speaker_label || "unknown", match_status: speaker.match_status || "unknown", authenticated_identity: speaker.authenticated_identity || "none", speaker_familiarity: speaker.speaker_familiarity || "none", anonymous_speaker_id: speaker.anonymous_speaker_id || null, exp: clock() + ttlMs })).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },
    verify(assertion) {
      if (!secret || typeof assertion !== "string") return null;
      const [payload, supplied, extra] = assertion.split("."); if (!payload || !supplied || extra) return null;
      const expected = sign(payload); const left = Buffer.from(supplied); const right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
      try { const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return value.exp >= clock() ? value : null; } catch { return null; }
    }
  });
}
