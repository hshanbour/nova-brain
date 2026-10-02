export function createNovaPhoneBridgeClient({ baseUrl, fetchImpl = globalThis.fetch }) {
  const post = async (path, body, token) => {
    const response = await fetchImpl(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(75_000) });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(value?.error || "Nova phone bridge request failed."), { code: value?.code || "phone_bridge_nova_failed", statusCode: response.status });
    return value;
  };
  return Object.freeze({
    start(input) { return post("/api/phone/bridge/session/start", input); },
    turn(input, token) { return post("/api/phone/bridge/turn", input, token); },
    event(input, token) { return post("/api/phone/bridge/event", input, token); },
  });
}
