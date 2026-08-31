export function createVoiceV2({
  capture, client, playback, sendTurn,
  onTranscript = () => {}, onState = () => {}, onError = () => {}, onNotice = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay), cancelSchedule = (timer) => clearTimeout(timer), retryDelayMs = 900
}) {
  let active = false; let state = "idle"; let generation = 0; let retryTimer; let abortController;
  const publish = (next, detail = {}) => { state = next; onState({ active, state, ...detail }); };
  const clearRetry = () => { if (retryTimer !== undefined) cancelSchedule(retryTimer); retryTimer = undefined; };
  const abortPending = () => { abortController?.abort(); abortController = undefined; };
  const valid = (current) => active && current === generation;

  function listen() {
    if (!active) return; clearRetry(); abortPending(); playback.stop(); capture.stop(); publish("listening");
    capture.listen({ onAudio: (recording) => processRecording(recording), onNoSpeech: () => retry("No speech detected."), onError: (error) => fatal(error?.message || "Microphone recording failed.") });
  }
  function retry(message) {
    if (!active) return; clearRetry(); publish("retrying"); onNotice(message);
    retryTimer = schedule(() => { retryTimer = undefined; if (active) listen(); }, retryDelayMs);
  }
  function recover(message) {
    if (!active) return; publish("error"); onError(message); retry("Voice is recovering…");
  }
  function fatal(message) {
    active = false; generation += 1; clearRetry(); abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message);
  }

  async function processRecording(recording) {
    if (!active || state !== "listening") return false;
    const current = ++generation; capture.stop(); abortController = new AbortController(); publish("transcribing");
    try {
      const { transcript } = await client.transcribe({ ...recording, signal: abortController.signal });
      if (!valid(current)) return false;
      const text = String(transcript || "").trim(); if (!text) { retry("No speech was understood."); return false; }
      onTranscript(text); publish("thinking");
      const result = await sendTurn(text);
      if (!valid(current)) return false;
      publish("speaking"); capture.watchForBargeIn(() => interrupt()); abortController = new AbortController();
      let speech;
      try { speech = await client.speech(result.message, { signal: abortController.signal }); }
      catch (error) { if (error?.name === "AbortError" || !valid(current)) return false; recover("Nova's written reply is safe, but ElevenLabs could not speak it."); return false; }
      if (!valid(current)) return false;
      playback.play(speech.audio, { onEnded: () => { if (valid(current)) listen(); }, onError: () => { if (valid(current)) recover("Nova's written reply is safe, but audio playback failed."); } });
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || !valid(current)) return false;
      recover(state === "transcribing" ? "Nova could not transcribe that turn. Please try again." : error?.message || "Nova could not complete that voice turn."); return false;
    }
  }

  function interrupt() {
    if (!active || state !== "speaking") return false;
    generation += 1; clearRetry(); abortPending(); playback.stop(); capture.stop(); publish("interrupted"); listen(); return true;
  }

  return Object.freeze({
    async start() {
      if (active) return false; active = true; const current = ++generation; publish("connecting");
      try { await capture.connect(); if (!valid(current)) return false; listen(); return true; }
      catch (error) { fatal(error?.message || "Microphone permission was denied or no microphone is available."); return false; }
    },
    end() { if (!active && state === "idle") return; active = false; generation += 1; clearRetry(); abortPending(); capture.stop(); playback.stop(); Promise.resolve(capture.destroy()).catch(() => {}); publish("idle"); },
    interrupt,
    isActive: () => active,
    getState: () => state
  });
}
