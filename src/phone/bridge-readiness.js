export async function waitForBridgeReady({ healthUrl, fetchImpl, attempts = 8, requestTimeoutMs = 2_000, delayMs = 250, schedule = setTimeout }) {
  if (!/^https:\/\//.test(String(healthUrl || ""))) throw new TypeError("Bridge health URL must use HTTPS.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required.");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(healthUrl, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (body?.ready === true && body?.acceptingCalls === true && body?.providerCertificationReady === true) return Object.freeze({ ready: true, providerCertificationReady: true, attempts: attempt });
    } catch (error) {
      if (attempt === attempts) throw new Error("Realtime bridge did not become ready before dial.", { cause: error });
    } finally { clearTimeout(timeout); }
    if (attempt < attempts) await new Promise((resolve) => schedule(resolve, delayMs));
  }
  throw new Error("Realtime bridge did not become ready before dial.");
}
