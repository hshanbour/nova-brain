const TWILIO_ENCODING = "audio/x-mulaw";
const TWILIO_EVENTS = new Set(["connected", "start", "media", "mark", "dtmf", "stop"]);
const CALL_SID = /^CA[a-fA-F0-9]{32}$/;
const STREAM_SID = /^MZ[a-fA-F0-9]{32}$/;

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
  if (!TWILIO_EVENTS.has(message.event)) throw new TwilioMediaProtocolError("Twilio media message event is unsupported.");
  if (message.event === "connected") validateConnected(message);
  if (message.event === "start") validateStart(message);
  if (message.event === "media" && typeof message.media?.payload !== "string") {
    throw new TwilioMediaProtocolError("Twilio media message is missing audio.");
  }
  if (message.event === "dtmf" && !/^[0-9*#]$/.test(String(message.dtmf?.digit || ""))) {
    throw new TwilioMediaProtocolError("Twilio DTMF message is invalid.");
  }
  return message;
}

function validateConnected(message) {
  if (message.protocol !== "Call" || message.version !== "1.0.0") {
    throw new TwilioMediaProtocolError("Twilio connected message protocol is unsupported.");
  }
}

function validateStart(message) {
  const start = message.start;
  const format = start?.mediaFormat;
  if (!STREAM_SID.test(message.streamSid || "") || !CALL_SID.test(start?.callSid || "")) throw new TwilioMediaProtocolError("Twilio start message is missing valid call identity.");
  if (start.streamSid && start.streamSid !== message.streamSid) throw new TwilioMediaProtocolError("Twilio start stream identity does not match.");
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
