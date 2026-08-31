export function createVoiceV2({
  capture, client, playback, sendTurn,
  onTranscript = () => {}, onState = () => {}, onError = () => {}, onNotice = () => {}, onTiming = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay), cancelSchedule = (timer) => clearTimeout(timer),
  now = () => globalThis.performance?.now?.() ?? Date.now(), retryDelayMs = 900
}) {
  let active = false; let state = "idle"; let generation = 0; let retryTimer; let abortController; let turnSequence = 0; let timing;
  const publish = (next, detail = {}) => { state = next; onState({ active, state, ...detail }); };
  const clearRetry = () => { if (retryTimer !== undefined) cancelSchedule(retryTimer); retryTimer = undefined; };
  const abortPending = () => { abortController?.abort(); abortController = undefined; };
  const valid = (current) => active && current === generation;
  const mark = (name, value = now()) => { if (timing) timing[name] = value; };
  const reportTiming = (stage) => { if (timing) onTiming(timingSnapshot(timing, stage)); };

  function listen({ afterAudio = false } = {}) {
    if (!active) return; clearRetry(); abortPending(); playback.stop();
    const current = generation; publish("getting_ready");
    capture.listen({
      onReady: () => {
        if (!valid(current)) return;
        mark("listeningReadyAt"); publish("listening");
        if (afterAudio) reportTiming("listening-ready");
      },
      onAudio: (recording) => processRecording(recording),
      onNoSpeech: () => retry("No speech detected."),
      onError: (error) => fatal(error?.message || "Microphone recording failed.")
    });
  }

  function retry(message) {
    if (!active) return; clearRetry(); publish("retrying"); onNotice(message);
    retryTimer = schedule(() => { retryTimer = undefined; if (active) listen(); }, retryDelayMs);
  }

  function recover(message) {
    if (!active) return; publish("error"); onError(message); reportTiming("error"); retry("Voice is recovering…");
  }

  function fatal(message) {
    active = false; generation += 1; clearRetry(); abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message); reportTiming("fatal-error");
  }

  async function processRecording(recording) {
    if (!active || state !== "listening") return false;
    const current = ++generation; capture.stop(); abortController = new AbortController();
    timing = { turnId: ++turnSequence, turnEndedAt: Number.isFinite(recording?.endedAt) ? recording.endedAt : now() };
    mark("sttStartedAt"); publish("transcribing");
    try {
      const { transcript } = await client.transcribe({ ...recording, signal: abortController.signal });
      if (!valid(current)) return false;
      mark("transcriptAvailableAt");
      const text = String(transcript || "").trim(); if (!text) { retry("No speech was understood."); return false; }
      onTranscript(text); publish("thinking"); mark("agentRequestStartedAt");
      const result = await sendTurn(text, {
        signal: abortController.signal,
        prepareAssistant: async (message) => {
          if (!valid(current)) throw abortError();
          mark("assistantAvailableAt"); publish("speaking", { phase: "preparing-audio" });
          capture.watchForBargeIn(() => interrupt()); mark("ttsStartedAt");
          const speech = await client.speech(message, { signal: abortController.signal });
          if (!valid(current)) throw abortError();
          mark("audioAvailableAt"); return speech;
        }
      });
      if (!valid(current)) return false;
      if (result.preparationError) {
        if (result.preparationError?.name === "AbortError") return false;
        recover("Nova's written reply is safe, but ElevenLabs could not speak it."); return false;
      }
      const speech = result.preparedAssistant;
      if (!speech?.audio) { recover("Nova's written reply is safe, but ElevenLabs returned no playable audio."); return false; }
      playback.play(speech.audio, {
        onStarted: () => { if (valid(current)) { mark("audioStartedAt"); reportTiming("audio-started"); } },
        onEnded: () => { if (valid(current)) { mark("audioEndedAt"); listen({ afterAudio: true }); } },
        onError: () => { if (valid(current)) recover("Nova's written reply is safe, but audio playback failed."); }
      });
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || !valid(current)) return false;
      recover(state === "transcribing" ? "Nova could not transcribe that turn. Please try again." : error?.message || "Nova could not complete that voice turn."); return false;
    }
  }

  function interrupt() {
    if (!active || state !== "speaking") return false;
    reportTiming("interrupted"); generation += 1; clearRetry(); abortPending(); playback.stop(); capture.stop(); publish("interrupted"); listen(); return true;
  }

  return Object.freeze({
    async start() {
      if (active) return false; active = true; const current = ++generation; publish("connecting");
      try { await capture.connect(); if (!valid(current)) { await capture.destroy(); return false; } listen(); return true; }
      catch (error) { if (!valid(current)) { await capture.destroy(); return false; } fatal(error?.message || "Microphone permission was denied or no microphone is available."); return false; }
    },
    end() { if (!active && state === "idle") return; active = false; generation += 1; clearRetry(); abortPending(); capture.stop(); playback.stop(); Promise.resolve(capture.destroy()).catch(() => {}); publish("idle"); },
    interrupt,
    isActive: () => active,
    getState: () => state,
    getLastTiming: () => timing ? timingSnapshot(timing, "snapshot") : null
  });
}

function timingSnapshot(timing, stage) {
  const difference = (end, start) => Number.isFinite(timing[end]) && Number.isFinite(timing[start]) ? rounded(timing[end] - timing[start]) : undefined;
  return Object.freeze({
    turnId: timing.turnId,
    stage,
    measurements: compact({
      turnEndToSttStart: difference("sttStartedAt", "turnEndedAt"),
      stt: difference("transcriptAvailableAt", "sttStartedAt"),
      transcriptToAgent: difference("agentRequestStartedAt", "transcriptAvailableAt"),
      agent: difference("assistantAvailableAt", "agentRequestStartedAt"),
      assistantToTtsStart: difference("ttsStartedAt", "assistantAvailableAt"),
      tts: difference("audioAvailableAt", "ttsStartedAt"),
      audioReadyToStart: difference("audioStartedAt", "audioAvailableAt"),
      audioEndToListening: difference("listeningReadyAt", "audioEndedAt")
    })
  });
}

function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function rounded(value) { return Math.round(Math.max(0, value) * 10) / 10; }
function abortError() { const error = new Error("Voice turn was interrupted."); error.name = "AbortError"; return error; }
