function xml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]); }

export function outboundCallTwiml({ bridgeWebSocketUrl, sessionToken }) {
  return `<Response><Connect><Stream url="${xml(bridgeWebSocketUrl)}"><Parameter name="novaSessionToken" value="${xml(sessionToken)}"/></Stream></Connect></Response>`;
}

export function createTwilioOutboundClient({ accountSid, authToken, fromNumber, bridgeWebSocketUrl, publicBaseUrl, fetchImpl = globalThis.fetch }) {
  const configured = [accountSid, authToken, fromNumber, bridgeWebSocketUrl, publicBaseUrl].every(Boolean);
  return Object.freeze({
    configured,
    async dial({ callIntentId, destination, sessionToken, submissionKey, maximumDurationMinutes }) {
      if (!configured) throw Object.assign(new Error("Twilio outbound calling is not configured."), { code: "phone_provider_not_configured", statusCode: 503, definitive: true });
      const body = new URLSearchParams({
        To: destination,
        From: fromNumber,
        Twiml: outboundCallTwiml({ bridgeWebSocketUrl, sessionToken }),
        StatusCallback: `${publicBaseUrl}/api/phone/twilio/status/${encodeURIComponent(callIntentId)}`,
        StatusCallbackMethod: "POST",
        TimeLimit: String(Number(maximumDurationMinutes) * 60),
      });
      for (const event of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", event);
      let response;
      try {
        response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`, {
          method: "POST",
          headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": submissionKey },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (cause) {
        throw Object.assign(new Error("Twilio dial submission has an uncertain outcome.", { cause }), { code: "phone_dial_uncertain", statusCode: 503, definitive: false });
      }
      const result = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error("Twilio rejected the dial request."), { code: "phone_dial_rejected", statusCode: 502, definitive: response.status >= 400 && response.status < 500, upstreamStatus: response.status });
      if (!/^CA[a-fA-F0-9]{32}$/.test(result?.sid || "")) throw Object.assign(new Error("Twilio returned an invalid call identity."), { code: "phone_dial_uncertain", statusCode: 502, definitive: false });
      return Object.freeze({ callSid: result.sid, providerStatus: result.status || "queued" });
    },
  });
}
