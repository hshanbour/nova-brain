const TWILIO_ENCODING = "audio/x-mulaw";

export class TwilioMediaProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "TwilioMediaProtocolError";
    this.code = "TWILIO_MEDIA_PROTOCOL_INVALID";
  }
}

export function parseTwilioMediaMessage(raw) {
  let message;
  try { message = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new TwilioMediaProtocolError("Twilio media message is not valid JSON."); }
  if (!message || typeof message !== "object" || typeof message.event !== "string") {
    throw new TwilioMediaProtocolError("Twilio media message is missing an event.");
  }
  if (message.event === "start") validateStart(message);
  if (message.event === "media" && typeof message.media?.payload !== "string") {
    throw new TwilioMediaProtocolError("Twilio media message is missing audio.");
  }
  return message;
}

function validateStart(message) {
  const start = message.start;
  const format = start?.mediaFormat;
  if (!message.streamSid || !start?.callSid) throw new TwilioMediaProtocolError("Twilio start message is missing call identity.");
  if (format?.encoding !== TWILIO_ENCODING || Number(format?.sampleRate) !== 8_000 || Number(format?.channels) !== 1) {
    throw new TwilioMediaProtocolError("Twilio stream must use mono 8 kHz mu-law audio.");
  }
}

export function twilioMedia(streamSid, audio) {
  if (!streamSid || !Buffer.isBuffer(audio) || !audio.length) throw new TwilioMediaProtocolError("Outbound Twilio audio is invalid.");
  return { event: "media", streamSid, media: { payload: audio.toString("base64") } };
}

export function twilioClear(streamSid) {
  if (!streamSid) throw new TwilioMediaProtocolError("A stream SID is required.");
  return { event: "clear", streamSid };
}

export function twilioMark(streamSid, name) {
  if (!streamSid || !name) throw new TwilioMediaProtocolError("A stream SID and mark name are required.");
  return { event: "mark", streamSid, mark: { name } };
}

export const TWILIO_MEDIA_FORMAT = Object.freeze({ encoding: TWILIO_ENCODING, sampleRate: 8_000, channels: 1 });
