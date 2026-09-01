export function createVoiceV2({
  capture, client, playback, sendTurn,
  onTranscript = () => {}, onState = () => {}, onError = () => {}, onNotice = () => {}, onTiming = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay), cancelSchedule = (timer) => clearTimeout(timer),
  now = () => globalThis.performance?.now?.() ?? Date.now(), retryDelayMs = 900, ttsRecoveryDelayMs = 250, checkpointTtlMs = 120_000
}) {
  let active = false; let state = "idle"; let generation = 0; let retryTimer; let abortController; let turnSequence = 0; let timing; let interruptedCheckpoint;
  const publish = (next, detail = {}) => { state = next; onState({ active, state, ...detail }); };
  const clearRetry = () => { if (retryTimer !== undefined) cancelSchedule(retryTimer); retryTimer = undefined; };
  const abortPending = () => { abortController?.abort(); abortController = undefined; };
  const valid = (current) => active && current === generation;
  const mark = (name, value = now()) => { if (timing) timing[name] = value; };
  const reportTiming = (stage) => { if (timing) onTiming(timingSnapshot(timing, stage)); };

  function listen({ afterAudio = false, interruptionProbe = false } = {}) {
    if (!active) return; clearRetry(); if(!interruptionProbe){abortPending();playback.stop();}
    const current = generation; publish("getting_ready");
    capture.listen({
      onReady: () => {
        if (!valid(current)) return;
        mark("listeningReadyAt"); publish("listening");
        if (afterAudio) reportTiming("listening-ready");
      },
      onAudio: (recording) => processRecording(recording,{interruptionProbe}),
      onNoSpeech: () => interruptionProbe?resumeInterrupted("No valid speech detected. Resuming Nova."):retry("No speech detected."),
      onError: (error) => fatal(error?.message || "Microphone recording failed."),
      onEndpoint: ({ phase, graceMs }) => { if (valid(current)) publish("listening", { phase: phase === "possible-end" ? "endpoint-grace" : "speech-resumed", graceMs }); }
    });
  }

  function retry(message, delayMs = retryDelayMs) {
    if (!active) return; clearRetry(); publish("retrying"); onNotice(message);
    retryTimer = schedule(() => { retryTimer = undefined; if (active) listen(); }, delayMs);
  }

  function recover(message, delayMs = retryDelayMs) {
    if (!active) return; abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message); reportTiming("error"); retry("Voice is recovering…", delayMs);
  }

  function fatal(message) {
    active = false; generation += 1; clearRetry(); abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message); reportTiming("fatal-error");
  }

  async function processRecording(recording,{interruptionProbe=false}={}) {
    if (!active || state !== "listening") return false;
    const priorController=abortController; let current = interruptionProbe?generation:++generation; capture.stop();
    if(!interruptionProbe)priorController?.abort();
    const transcriptController=new AbortController(); abortController=transcriptController;
    const recordingFinalizedAt = Number.isFinite(recording?.endedAt) ? recording.endedAt : now();
    timing = {
      turnId: ++turnSequence,
      speechEndedAt: Number.isFinite(recording?.speechEndedAt) ? recording.speechEndedAt : recordingFinalizedAt,
      endpointGraceStartedAt: Number.isFinite(recording?.endpointStartedAt) ? recording.endpointStartedAt : undefined,
      recordingFinalizedAt
    };
    reportTiming("recording-finalized");
    mark("sttStartedAt"); publish("transcribing");
    try {
      const transcribed = await client.transcribe({ ...recording, signal: abortController.signal });
      const { transcript, speaker } = transcribed;
      if (!valid(current)) return false;
      mark("transcriptAvailableAt");
      if(Number.isFinite(transcribed?.timing?.speakerRecognitionMs))timing.speakerRecognitionMs=transcribed.timing.speakerRecognitionMs;
      const text = String(transcript || "").trim();
      if(interruptionProbe&&(!text||isContinueIntent(text)))return resumeInterrupted(text?"Continuing Nova's interrupted response.":"No speech was understood. Resuming Nova.");
      if (!text) { retry("No speech was understood."); return false; }
      if(interruptionProbe){interruptedCheckpoint=undefined;playback.stop();current=++generation;abortPending();abortController=new AbortController();}
      onTranscript(text); publish("thinking"); mark("agentRequestStartedAt");
      const result = await sendTurn(text, {
        signal: abortController.signal,
        speaker,
        prepareAssistant: async (message,assistantResult) => {
          if (!valid(current)) throw abortError();
          if(assistantResult?.timing){timing.contextRetrievalMs=assistantResult.timing.contextRetrievalMs;timing.agentFirstResponseMs=assistantResult.timing.agentFirstResponseMs;timing.agentCompleteMs=assistantResult.timing.agentCompleteMs;}
          mark("assistantAvailableAt"); publish("speaking", { phase: "preparing-audio" });
          interruptedCheckpoint={assistantTurnId:assistantResult?.id||`voice-${turnSequence}`,message,conversationId:assistantResult?.conversationId||null,createdAt:now(),chunkIndex:0};
          capture.watchForBargeIn(() => interrupt()); mark("ttsStartedAt");
          const speech = await client.speech(message, { signal: abortController.signal });
          if (!valid(current)) throw abortError();
          if (speech?.timing) {
            mark("ttsResponseHeadersAt", speech.timing.responseHeadersAt);
            mark("ttsFirstAudioByteAt", speech.timing.firstAudioByteAt);
            mark("ttsFirstPlayableAt", speech.timing.firstPlayableAt);
          }
          mark("audioAvailableAt"); return speech;
        }
      });
      if (!valid(current)) return false;
      if (result.preparationError) {
        if (result.preparationError?.name === "AbortError") return false;
        recover(voiceFailureMessage(result.preparationError), ttsRecoveryDelayMs); return false;
      }
      const speech = result.preparedAssistant;
      if (!speech?.audio) { recover("Nova's written reply is safe, but ElevenLabs returned no playable audio.", ttsRecoveryDelayMs); return false; }
      playback.play(speech.stream || speech.audio, {
        onStarted: () => { if (valid(current)) { mark("audioStartedAt"); reportTiming("audio-started"); } },
        onChunkStarted:({index}={})=>{if(interruptedCheckpoint&&Number.isInteger(index))interruptedCheckpoint.chunkIndex=index;},
        onEnded: () => { if (valid(current)) { mark("audioEndedAt"); listen({ afterAudio: true }); } },
        onError: (error) => { if (valid(current)) recover(voiceFailureMessage(error, true), ttsRecoveryDelayMs); }
      });
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || !valid(current)) return false;
      recover(state === "transcribing" ? "Nova could not transcribe that turn. Please try again." : error?.message || "Nova could not complete that voice turn."); return false;
    }
  }

  function interrupt() {
    if (!active || state !== "speaking") return false;
    reportTiming("interrupted");clearRetry();const playbackState=playback.checkpoint?.();
    if(!playbackState){generation+=1;abortPending();playback.stop();capture.stop();publish("interrupted");listen();return true;}
    playback.pause?.();interruptedCheckpoint={...(interruptedCheckpoint||{}),playback:playbackState,interruptedAt:now()};capture.stop();publish("interrupted");listen({interruptionProbe:true});return true;
  }

  function resumeInterrupted(message){
    if(!active||!interruptedCheckpoint||now()-(interruptedCheckpoint.interruptedAt||interruptedCheckpoint.createdAt)>checkpointTtlMs){interruptedCheckpoint=undefined;retry(message||"Nothing recent is available to continue.");return false;}
    capture.stop();publish("speaking",{phase:"resuming",assistantTurnId:interruptedCheckpoint.assistantTurnId,chunkIndex:interruptedCheckpoint.chunkIndex});
    if(!playback.resume?.()){interruptedCheckpoint=undefined;retry("The interrupted audio is no longer available.");return false;}
    capture.watchForBargeIn(()=>interrupt());onNotice(message);return true;
  }

  return Object.freeze({
    async start() {
      if (active) return false; active = true; const current = ++generation; publish("connecting");
      try { await capture.connect(); if (!valid(current)) { await capture.destroy(); return false; } listen(); return true; }
      catch (error) { if (!valid(current)) { await capture.destroy(); return false; } fatal(error?.message || "Microphone permission was denied or no microphone is available."); return false; }
    },
    end() { if (!active && state === "idle") return; active = false; generation += 1; interruptedCheckpoint=undefined;clearRetry(); abortPending(); capture.stop(); playback.stop(); Promise.resolve(capture.destroy()).catch(() => {}); publish("idle"); },
    interrupt,
    isActive: () => active,
    getState: () => state,
    getLastTiming: () => timing ? timingSnapshot(timing, "snapshot") : null,
    getInterruptedCheckpoint:()=>interruptedCheckpoint?{assistantTurnId:interruptedCheckpoint.assistantTurnId,conversationId:interruptedCheckpoint.conversationId,chunkIndex:interruptedCheckpoint.chunkIndex,interruptedAt:interruptedCheckpoint.interruptedAt}:null
  });
}

function timingSnapshot(timing, stage) {
  const difference = (end, start) => Number.isFinite(timing[end]) && Number.isFinite(timing[start]) ? rounded(timing[end] - timing[start]) : undefined;
  return Object.freeze({
    turnId: timing.turnId,
    stage,
    measurements: compact({
      speechEndToEndpoint: difference("recordingFinalizedAt", "speechEndedAt"),
      endpointToStt: difference("sttStartedAt", "recordingFinalizedAt"),
      intentionalEndpointWait: difference("recordingFinalizedAt", "speechEndedAt"),
      endpointGrace: difference("recordingFinalizedAt", "endpointGraceStartedAt"),
      recordingFinalizeToSttStart: difference("sttStartedAt", "recordingFinalizedAt"),
      stt: difference("transcriptAvailableAt", "sttStartedAt"),
      speakerRecognition: timing.speakerRecognitionMs,
      contextRetrieval: timing.contextRetrievalMs,
      transcriptToAgent: difference("agentRequestStartedAt", "transcriptAvailableAt"),
      agent: difference("assistantAvailableAt", "agentRequestStartedAt"),
      agentFirstResponse: timing.agentFirstResponseMs,
      agentComplete: timing.agentCompleteMs,
      assistantToTtsStart: difference("ttsStartedAt", "assistantAvailableAt"),
      ttsResponseHeaders: difference("ttsResponseHeadersAt", "ttsStartedAt"),
      ttsFirstAudioByte: difference("ttsFirstAudioByteAt", "ttsStartedAt"),
      ttsFirstPlayable: difference("ttsFirstPlayableAt", "ttsStartedAt"),
      tts: difference("audioAvailableAt", "ttsStartedAt"),
      audioReadyToStart: difference("audioStartedAt", "audioAvailableAt"),
      playback: difference("audioEndedAt", "audioStartedAt"),
      speechEndToPlayback: difference("audioStartedAt", "speechEndedAt"),
      totalSpeechEndToAudio: difference("audioStartedAt", "speechEndedAt"),
      audioEndToListening: difference("listeningReadyAt", "audioEndedAt")
    })
  });
}

function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function rounded(value) { return Math.round(Math.max(0, value) * 10) / 10; }
function abortError() { const error = new Error("Voice turn was interrupted."); error.name = "AbortError"; return error; }
function isContinueIntent(text){return /^(?:please\s+)?(?:continue|go on|carry on)(?:\s+please)?[.!?\s]*$|^(?:كم[ّ]?ل|كمل|وين\s+كنت[؟?،,\s]*كم[ّ]?ل)[.!؟?\s]*$/iu.test(String(text||"").trim());}
function voiceFailureMessage(error,browserFallback=false){if(error?.category==="quota")return "Nova's written reply is safe, but ElevenLabs credits are exhausted.";if(error?.category==="authentication")return "Nova's written reply is safe, but ElevenLabs authentication needs attention.";if(error?.category==="voice_access")return "Nova's written reply is safe, but the selected ElevenLabs voice is unavailable.";if(error?.category==="rate_limit")return "Nova's written reply is safe, but ElevenLabs is temporarily busy.";if(["provider_timeout_first_byte","provider_stream_stalled"].includes(error?.category))return "Nova's written reply is safe, but ElevenLabs audio timed out.";if(error?.message&&/written reply is safe/i.test(error.message))return error.message;return browserFallback?"Nova's written reply is safe, but audio playback failed.":"Nova's written reply is safe, but ElevenLabs could not speak it.";}
