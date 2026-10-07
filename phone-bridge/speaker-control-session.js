import { randomUUID } from "node:crypto";
import { createTelephonyVad } from "../src/phone/server-vad.js";
import { mulaw8kToWav } from "../src/phone/g711.js";

const CONSENT_PROMPT = "مرحباً. هذه المشاركة اختيارية لمعايرة تعرّف نوفا على صوت محمد. الصوت الخام والبصمة المؤقتة يُحذفان، ولا ننشئ لك ملفاً صوتياً دائماً. يبقى فقط رقم مقارنة مجهول ومعلومات الموافقة. للموافقة اضغط واحد. للرفض اضغط اثنين. This optional calibration compares your voice with Mohammad's Nova recognition. Raw audio and temporary embeddings are discarded, no permanent profile is created, and only anonymous scalar statistics and consent metadata remain. Press 1 to consent or 2 to refuse.";
const ACCEPTED = "شكراً. تم قبول العينة. الجملة التالية:";
const RETRY = "العينة لم تحتوِ على كلام واضح كافٍ. سنعيد المحاولة بجملة جديدة، وبصوتك الطبيعي:";

export function createSpeakerControlSession({ sendTwilio, hangup = () => {}, tts, novaClient, authorization, callIntentId, callSid, streamSid, maximumDurationSeconds, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, idFactory = randomUUID } = {}) {
  const control = authorization?.control;
  if (!control?.sessionId || !/^control-0[1-3]$/.test(control.participantCode || "") || !Array.isArray(control.plan) || control.plan.length !== 4) throw Object.assign(new Error("Calibration-control authorization is incomplete."), { code: "speaker_control_authorization_invalid" });
  const vad = createTelephonyVad({ silenceFrames: 50 });
  let closed = false, processing = false, capturing = false, consent = "pending", consentReady = false, ordinal = 1, promptMark = null, audio = [], audioBytes = 0;
  const startedAt = clock(), timer = setTimer(() => void stop("completed", "maximum_duration"), maximumDurationSeconds * 1_000);
  timer.unref?.();
  const speak = async (text, markName) => { for await (const chunk of tts.stream(text)) sendTwilio({ event: "media", streamSid, media: { payload: Buffer.from(chunk).toString("base64") } }); promptMark = markName; sendTwilio({ event: "mark", streamSid, mark: { name: markName } }); };
  const clearAudio = () => { audio = []; audioBytes = 0; capturing = false; vad.reset(); };
  const prompt = async (prefix = "") => { clearAudio(); const item = control.plan[ordinal - 1], switchInstruction = ordinal === 3 ? "قبل الجملة التالية، حط الهاتف على السبيكر على مسافة طبيعية. " : ""; await speak(`${prefix}${prefix ? " " : ""}${switchInstruction}${item.text}`, `control-prompt-${ordinal}-${idFactory()}`); };
  async function decide(decision) {
    if (consent !== "pending" || processing || closed) return { ignored: true };
    processing = true; clearAudio();
    const result = await novaClient.controlConsent({ sessionId: control.sessionId, participantCode: control.participantCode, callIntentId, callSid, streamSid, decision, method: "in_call_dtmf" }, authorization.bridgeSessionToken);
    processing = false; consent = decision === "consent" ? "granted" : "refused";
    if (decision === "refuse") { await speak("شكراً. لن يتم جمع أو معالجة أي عينة صوتية، وستنتهي المكالمة الآن. Thank you. No voice sample will be collected or processed.", `control-refused-${idFactory()}`); return result; }
    await prompt("شكراً لموافقتك. سنجمع أربع عينات قصيرة فقط. استخدم الهاتف بشكل عادي لأول عينتين، وتحدث بصوتك الطبيعي:");
    return result;
  }
  async function finalize() {
    if (processing || !capturing || closed || consent !== "granted") return;
    processing = true; capturing = false;
    const payload = Buffer.concat(audio); audio = []; audioBytes = 0;
    const item = control.plan[ordinal - 1], durationSeconds = payload.length / 8_000;
    const result = await novaClient.controlSample({ sessionId: control.sessionId, participantCode: control.participantCode, callIntentId, callSid, streamSid, submissionKey: `control:${control.sessionId}:${ordinal}:${idFactory()}`, ordinal, promptId: item.id, audioBase64: mulaw8kToWav(payload).toString("base64"), mimeType: "audio/wav", durationSeconds }, authorization.bridgeSessionToken);
    processing = false;
    if (result.retry) { await prompt(RETRY); return; }
    ordinal += 1;
    if (ordinal > 4) { await speak("شكراً. اكتملت عينات المعايرة المجهولة. لم نحتفظ بالصوت الخام أو ببصمة صوتية لك، وستنتهي المكالمة الآن.", `control-complete-${idFactory()}`); return; }
    await prompt(ACCEPTED);
  }
  async function stop(type = "completed", providerStatus = "disconnected", { hangupSocket = true } = {}) {
    if (closed) return false; closed = true; clearTimer(timer); clearAudio();
    if (authorization.bridgeSessionToken) await novaClient.event({ callIntentId, callSid, streamSid, eventId: `bridge-stop-${callIntentId}-${streamSid}`, type, providerStatus }, authorization.bridgeSessionToken).catch(() => {});
    if (hangupSocket) hangup(); return true;
  }
  return Object.freeze({
    async start() { clearAudio(); await speak(CONSENT_PROMPT, `control-consent-${idFactory()}`); return authorization; },
    async handle(message) {
      if (closed) return { ignored: true };
      if (message.event === "dtmf" && consent === "pending") { const digit = String(message.dtmf?.digit || ""); if (!consentReady) return { ignored: true }; if (digit === "1") return decide("consent"); if (digit === "2") return decide("refuse"); return { ignored: true }; }
      if (message.event === "mark" && message.mark?.name === promptMark) {
        if (promptMark.startsWith("control-consent-")) { consentReady = true; promptMark = null; return { consentReady: true }; }
        if (promptMark.startsWith("control-refused-")) { await stop("completed", "participant_refused"); return { refused: true }; }
        if (promptMark.startsWith("control-complete-")) { await stop("completed", "control_session_complete"); return { completed: true }; }
        if (promptMark.startsWith("control-prompt-") && consent === "granted") { capturing = true; promptMark = null; return { captureStarted: true }; }
        promptMark = null; return { acknowledged: true };
      }
      if (message.event === "media") {
        if (consent !== "granted" || !capturing || processing) return { ignored: true };
        const chunk = Buffer.from(message.media.payload, "base64");
        if (audioBytes + chunk.length <= 15 * 8_000) { audio.push(chunk); audioBytes += chunk.length; }
        const activity = vad.push(message.media.payload); if (activity.event === "speech_ended") await finalize();
      }
      if (message.event === "stop") await stop("completed", "disconnected", { hangupSocket: false });
      return {};
    },
    stop,
    metrics() { return { elapsedMs: clock() - startedAt, consent, rawAudioPersisted: false, controlEmbeddingPersisted: false, acceptedPromptOrdinal: ordinal - 1 }; },
  });
}
