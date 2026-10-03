import { createHmac, timingSafeEqual } from "node:crypto";

function expectedSignature({ authToken, url, parameters = {} }) {
  if (!authToken || !url) throw new TypeError("Twilio signature verification requires a token and exact URL.");
  let data = String(url);
  for (const key of Object.keys(parameters).sort()) {
    const values = Array.isArray(parameters[key]) ? [...parameters[key]].sort() : [parameters[key]];
    for (const value of values) data += `${key}${value ?? ""}`;
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(input) {
  const expected = Buffer.from(expectedSignature(input));
  const supplied = Buffer.from(String(input.signature || ""));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function assertTwilioSignature(input) {
  if (!verifyTwilioSignature(input))
    throw Object.assign(new Error("Twilio request signature is invalid."), { code: "phone_twilio_signature_invalid", statusCode: 401 });
  return true;
}

export function assertTwilioWebSocketSignature({ authToken, externalUrl, signature }) {
  const canonical = new URL(externalUrl);
  if (canonical.protocol !== "wss:" || canonical.username || canonical.password) {
    throw new TypeError("Twilio WebSocket signature verification requires an external WSS URL.");
  }
  const alternate = new URL(canonical);
  alternate.pathname = alternate.pathname.endsWith("/")
    ? alternate.pathname.slice(0, -1) || "/"
    : `${alternate.pathname}/`;
  const candidates = [...new Set([canonical.toString(), alternate.toString()])];
  const matchIndex = candidates.findIndex((url) => verifyTwilioSignature({ authToken, url, signature, parameters: {} }));
  if (matchIndex < 0) {
    throw Object.assign(new Error("Twilio request signature is invalid."), { code: "phone_twilio_signature_invalid", statusCode: 401 });
  }
  return matchIndex === 0 ? "exact" : "documented_trailing_slash_variant";
}

export const createTwilioSignatureForTest = expectedSignature;
