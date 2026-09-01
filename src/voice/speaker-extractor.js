const SUPPORTED_MIME_TYPES = new Set(["audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/ogg;codecs=opus", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);

export class SpeakerExtractorError extends Error {
  constructor(message, code = "extractor_unavailable") { super(message); this.name = "SpeakerExtractorError"; this.code = code; }
}

export function createSpeakerExtractor({ config, fetchImpl = fetch, clock = Date.now } = {}) {
  const speaker = config?.speakerRecognition || {};
  const configured = Boolean(speaker.endpoint && speaker.token);
  const securityConfigured = Boolean(speaker.embeddingKey && speaker.assertionKey && speaker.embeddingKey.length >= 32 && speaker.assertionKey.length >= 32);

  async function request(path, body, { signal, requestId, enrollmentAttemptId } = {}) {
    if (!configured) throw new SpeakerExtractorError("Speaker recognition worker is not configured.", "not_configured");
    const timeoutSignal=AbortSignal.timeout(45_000);const requestSignal=signal&&typeof AbortSignal.any==="function"?AbortSignal.any([signal,timeoutSignal]):timeoutSignal;
    let response;
    try {
      response = await fetchImpl(`${speaker.endpoint.replace(/\/$/, "")}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${speaker.token}`, "Content-Type": "application/json", Accept: "application/json", ...(requestId?{"X-Nova-Request-Id":requestId}:{}), ...(enrollmentAttemptId?{"X-Nova-Enrollment-Attempt-Id":enrollmentAttemptId}:{}) },
        body: JSON.stringify(body), signal:requestSignal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeoutSignal.aborted) throw new SpeakerExtractorError("Speaker recognition worker timed out.","extractor_timeout");
      throw new SpeakerExtractorError("Speaker recognition worker could not be reached.");
    }
    let data; try { data = await response.json(); } catch { throw new SpeakerExtractorError("Speaker recognition worker returned an unreadable response.", "invalid_response"); }
    if (!response.ok) throw new SpeakerExtractorError(typeof data?.error === "string" ? data.error : "Speaker recognition worker rejected the recording.", data?.code || "worker_rejected");
    return data;
  }

  return Object.freeze({
    configured,
    async readiness() {
      if (!configured || !securityConfigured) return { status: "Missing", available: false, model: speaker.modelVersion, reason: !configured ? "worker-configuration-missing" : "biometric-security-keys-missing", rawAudioPolicy: "ephemeral-request-only" };
      const startedAt = clock();
      try {
        const result = await request("/readiness", {});
        return { status: result.ready === true ? "Verified" : "Unavailable", available: result.ready === true, model: result.model || speaker.modelVersion, latencyMs: clock() - startedAt, rawAudioPolicy: "ephemeral-request-only", encryptedAtRest: true, signedAssertions: true };
      } catch (error) { return { status: "Unavailable", available: false, model: speaker.modelVersion, errorCode: error.code, latencyMs: clock() - startedAt, rawAudioPolicy: "ephemeral-request-only" }; }
    },
    async extract({ audioBase64, mimeType, durationSeconds }, { signal, requestId, enrollmentAttemptId } = {}) {
      const duration = Number(durationSeconds);
      if (!Number.isFinite(duration) || duration < speaker.minSpeechSeconds) return { sufficient: false, reason: "insufficient_speech", durationSeconds: Number.isFinite(duration) ? duration : 0, extractorVersion: speaker.modelVersion };
      if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw new SpeakerExtractorError("Unsupported speaker-recognition audio type.", "invalid_audio");
      if (typeof audioBase64 !== "string" || !audioBase64 || Buffer.byteLength(audioBase64, "base64") > speaker.maxAudioBytes) throw new SpeakerExtractorError("Invalid speaker-recognition audio.", "invalid_audio");
      const startedAt = clock(); const result = await request("/embed", { audioBase64, mimeType, durationSeconds: duration }, { signal, requestId, enrollmentAttemptId });
      if (!Array.isArray(result.embedding) || result.embedding.length < 64 || result.embedding.some((value) => !Number.isFinite(value))) throw new SpeakerExtractorError("Speaker recognition worker returned an invalid embedding.", "invalid_embedding");
      return { sufficient: true, representation: result.embedding, extractorVersion: result.model || speaker.modelVersion, speechSeconds: result.speechSeconds ?? duration, quality: result.quality || "accepted", latencyMs: clock() - startedAt };
    }
  });
}
