export function createTranscriptionSessionRotator({ createSession, rotateAfterSeconds = 55 * 60 }) {
  if (typeof createSession !== "function") throw new TypeError("createSession is required.");
  if (!Number.isFinite(rotateAfterSeconds) || rotateAfterSeconds <= 0) throw new TypeError("rotateAfterSeconds must be positive.");
  let current;
  let audioSeconds = 0;
  let rotations = 0;
  let closed = false;

  const ensureCurrent = () => {
    if (closed) throw new Error("Transcription rotator is closed.");
    if (!current) {
      current = createSession({ generation: rotations });
      current.start();
    }
    return current;
  };

  return Object.freeze({
    start() { ensureCurrent(); },
    appendMulaw(payloadBase64) {
      const bytes = Buffer.from(payloadBase64, "base64").length;
      audioSeconds += bytes / 8_000;
      return ensureCurrent().appendMulaw(payloadBase64);
    },
    async commit(options) {
      const result = await ensureCurrent().commit(options);
      if (audioSeconds >= rotateAfterSeconds && !closed) {
        current.close();
        rotations += 1;
        audioSeconds = 0;
        current = createSession({ generation: rotations });
        current.start();
      }
      return result;
    },
    handleServerEvent(event) { return ensureCurrent().handleServerEvent(event); },
    close() {
      if (closed) return false;
      closed = true;
      current?.close();
      return true;
    },
    metrics() { return Object.freeze({ rotations, generation: rotations, audioSeconds, closed }); },
  });
}
