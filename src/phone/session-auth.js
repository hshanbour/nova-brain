import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sign(payload, key) { return createHmac("sha256", key).update(payload).digest("base64url"); }

export function createPhoneSessionAuth({ key, clock = () => new Date(), randomBytesImpl = randomBytes }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("Phone session signing key must be 32 bytes.");
  const issue = (claims, ttlSeconds, purpose) => {
    const payload = encode({ v: 1, purpose, ...claims, jti: randomBytesImpl(18).toString("base64url"), exp: Math.floor(clock().getTime() / 1000) + ttlSeconds });
    return `${payload}.${sign(payload, key)}`;
  };
  const verify = (token, purpose) => {
    const [payload, signature, extra] = String(token || "").split(".");
    if (!payload || !signature || extra) throw Object.assign(new Error("Phone session token is invalid."), { code: "phone_session_token_invalid", statusCode: 401 });
    const expected = Buffer.from(sign(payload, key)); const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Object.assign(new Error("Phone session token is invalid."), { code: "phone_session_token_invalid", statusCode: 401 });
    let claims; try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { claims = null; }
    if (!claims || claims.v !== 1 || claims.purpose !== purpose || !claims.jti || claims.exp <= Math.floor(clock().getTime() / 1000))
      throw Object.assign(new Error("Phone session token is invalid or expired."), { code: "phone_session_token_expired", statusCode: 401 });
    return Object.freeze(claims);
  };
  return Object.freeze({
    issueStart(claims, ttlSeconds = 300) { return issue(claims, ttlSeconds, "phone_start"); },
    verifyStart(token) { return verify(token, "phone_start"); },
    issueBridge(claims, ttlSeconds) { return issue(claims, ttlSeconds, "phone_bridge"); },
    verifyBridge(token) { return verify(token, "phone_bridge"); },
    tokenHash: digest,
  });
}
