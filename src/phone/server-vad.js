import { decodeMulaw8k } from "./g711.js";

export function createTelephonyVad({ speechThreshold = 550, startFrames = 3, silenceFrames = 50 } = {}) {
  let speech = false, loud = 0, quiet = 0;
  return Object.freeze({
    push(payloadBase64) {
      const samples = decodeMulaw8k(Buffer.from(payloadBase64, "base64"));
      let sum = 0; for (const sample of samples) sum += Math.abs(sample);
      const level = samples.length ? sum / samples.length : 0;
      if (level >= speechThreshold) { loud += 1; quiet = 0; }
      else { quiet += 1; loud = 0; }
      if (!speech && loud >= startFrames) { speech = true; return { event: "speech_started", level }; }
      if (speech && quiet >= silenceFrames) { speech = false; loud = 0; quiet = 0; return { event: "speech_ended", level }; }
      return { event: null, level };
    },
    reset() { speech = false; loud = 0; quiet = 0; },
    speaking() { return speech; },
  });
}
