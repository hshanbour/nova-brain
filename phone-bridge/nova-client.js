export const AUTHORIZED_NOVA_PREVIEW_BASE_URL = "https://nova-test-project-git-codex-combine-ede5f3-hamodehshanbour-6196.vercel.app";

function normalizedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw Object.assign(new Error("Nova Preview destination must use HTTPS."), { code: "nova_preview_destination_not_authorized" });
  return url.origin;
}

export function protectionBypassHeadersFor({ destination, secret, authorizedBaseUrl = AUTHORIZED_NOVA_PREVIEW_BASE_URL }) {
  if (normalizedOrigin(destination) !== normalizedOrigin(authorizedBaseUrl)) return Object.freeze({});
  if (!secret) throw Object.assign(new Error("Vercel automation bypass configuration is required."), { code: "vercel_automation_bypass_missing" });
  return Object.freeze({ "x-vercel-protection-bypass": secret });
}

export function createNovaPhoneBridgeClient({
  baseUrl,
  protectionBypassSecret,
  authorizedBaseUrl = AUTHORIZED_NOVA_PREVIEW_BASE_URL,
  fetchImpl = globalThis.fetch,
}) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  if (normalizedOrigin(normalizedBaseUrl) !== normalizedOrigin(authorizedBaseUrl)) {
    throw Object.assign(new Error("Nova Preview destination is not authorized."), { code: "nova_preview_destination_not_authorized" });
  }

  const post = async (path, body, token) => {
    const destination = `${normalizedBaseUrl}${path}`;
    const response = await fetchImpl(destination, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...protectionBypassHeadersFor({ destination, secret: protectionBypassSecret, authorizedBaseUrl }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(75_000),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(value?.error || "Nova phone bridge request failed."), { code: value?.code || "phone_bridge_nova_failed", statusCode: response.status });
    return value;
  };

  const forwardTwilioStatus = async ({ callIntentId, rawBody, signature }) => {
    if (!/^phone_[a-f0-9]{32}$/.test(callIntentId || "")) {
      throw Object.assign(new Error("Twilio status callback identity is invalid."), { code: "phone_status_callback_invalid" });
    }
    const destination = `${normalizedBaseUrl}/api/phone/twilio/status/${callIntentId}`;
    const response = await fetchImpl(destination, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": String(signature || ""),
        ...protectionBypassHeadersFor({ destination, secret: protectionBypassSecret, authorizedBaseUrl }),
      },
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw Object.assign(new Error("Nova rejected the Twilio status callback."), {
        code: "phone_status_callback_rejected",
        statusCode: response.status,
      });
    }
    return Object.freeze({ accepted: true });
  };

  return Object.freeze({
    start(input) { return post("/api/phone/bridge/session/start", input); },
    turn(input, token) { return post("/api/phone/bridge/turn", input, token); },
    event(input, token) { return post("/api/phone/bridge/event", input, token); },
    enrollmentSample(input,token){return post("/api/phone/speaker-enrollment/sample",input,token);},
    controlConsent(input,token){return post("/api/phone/speaker-controls/consent",input,token);},
    controlSample(input,token){return post("/api/phone/speaker-controls/sample",input,token);},
    forwardTwilioStatus,
  });
}
