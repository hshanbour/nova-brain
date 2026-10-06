const MULAW_BIAS = 0x84;

export function decodeMulawSample(value) {
  const sample = (~Number(value)) & 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  const magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
  const decoded = magnitude - MULAW_BIAS;
  return sign ? -decoded : decoded;
}

export function decodeMulaw8k(payload) {
  const input = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) output[index] = decodeMulawSample(input[index]);
  return output;
}

export function resamplePcm16(input, inputRate = 8_000, outputRate = 24_000) {
  if (!(input instanceof Int16Array)) throw new TypeError("PCM input must be an Int16Array.");
  if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) {
    throw new TypeError("Sample rates must be positive integers.");
  }
  if (input.length === 0 || inputRate === outputRate) return new Int16Array(input);
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Int16Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(source));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = source - left;
    output[index] = Math.round(input[left] + ((input[right] - input[left]) * fraction));
  }
  return output;
}

export function pcm16ToLittleEndianBuffer(samples) {
  if (!(samples instanceof Int16Array)) throw new TypeError("PCM samples must be an Int16Array.");
  const output = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) output.writeInt16LE(samples[index], index * 2);
  return output;
}

export function mulaw8kToWav(payload) {
  const pcm = pcm16ToLittleEndianBuffer(decodeMulaw8k(payload));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24); header.writeUInt32LE(16_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function twilioMulawToOpenAiPcm(payloadBase64) {
  if (typeof payloadBase64 !== "string" || !payloadBase64) throw new TypeError("Twilio media payload is required.");
  const mulaw = Buffer.from(payloadBase64, "base64");
  if (!mulaw.length) throw new TypeError("Twilio media payload is empty.");
  const pcm24k = resamplePcm16(decodeMulaw8k(mulaw), 8_000, 24_000);
  return Object.freeze({
    pcm: pcm16ToLittleEndianBuffer(pcm24k),
    inputSamples: mulaw.length,
    outputSamples: pcm24k.length,
    inputRate: 8_000,
    outputRate: 24_000,
  });
}
