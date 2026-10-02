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

export const createTwilioSignatureForTest = expectedSignature;
