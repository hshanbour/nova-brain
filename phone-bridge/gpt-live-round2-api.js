import { AUTHORIZED_NOVA_PREVIEW_BASE_URL, protectionBypassHeadersFor } from "./nova-client.js";

function origin(value) { return new URL(value).origin; }

export function createGptLiveRound2Api({ baseUrl, authorizationSecret, protectionBypassSecret, fetchImpl = globalThis.fetch, timeoutMs = 75_000 } = {}) {
  const normalized = String(baseUrl || "").replace(/\/$/, "");
  if (origin(normalized) !== origin(AUTHORIZED_NOVA_PREVIEW_BASE_URL)) throw Object.assign(new Error("Round 2 destination is not authorized."), { code: "nova_preview_destination_not_authorized" });
  if (!authorizationSecret) throw Object.assign(new Error("Round 2 authorization is required."), { code: "gpt_live_round2_authorization_missing" });
  const post = async (operation, body, signal) => {
    const destination = `${normalized}/api/internal/phone/gpt-live-round2/${operation}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(destination, { method: "POST", headers: { "content-type": "application/json", "x-nova-round2-authorization": authorizationSecret, ...protectionBypassHeadersFor({ destination, secret: protectionBypassSecret }) }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(value?.error || "Round 2 request failed."), { code: value?.code || "gpt_live_round2_request_failed", statusCode: response.status });
    return value;
  };
  return Object.freeze({
    start(input, options = {}) { return post("start", input, options.signal); },
    greeting(input, options = {}) { return post("greeting", input, options.signal); },
    classify(input, options = {}) { return post("classify", input, options.signal); },
    speaker(input, options = {}) { return post("speaker", input, options.signal); },
    turn(input, options = {}) { return post("turn", input, options.signal); },
    playback(input, options = {}) { return post("playback", input, options.signal); },
    delivery(input, options = {}) { return post("delivery", input, options.signal); },
    restore(input, options = {}) { return post("restore", input, options.signal); },
    extract(input, options = {}) { return post("extract", input, options.signal); },
  });
}
