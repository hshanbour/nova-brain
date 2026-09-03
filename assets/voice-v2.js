export function createVoiceV2({
  capture, client, playback, interruptionPlayback = playback, sendTurn,
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
  const pausedWaiting = () => interruptedCheckpoint?.status === "paused_waiting_for_user";
  const reportBargeDiagnostic = (detail = {}) => onTiming({turnId:timing?.turnId,stage:`barge-${detail.phase||"candidate"}`,measurements:compact({speechOnset:Number.isFinite(detail.speechOnsetAt)?rounded(detail.speechOnsetAt):undefined,baselineRms:Number.isFinite(detail.baselineRms)?precise(detail.baselineRms):undefined,thresholdRms:Number.isFinite(detail.thresholdRms)?precise(detail.thresholdRms):undefined,peakUserRms:Number.isFinite(detail.peakRms)?precise(detail.peakRms):undefined,sustainedFrames:Number.isFinite(detail.sustainedFrames)?detail.sustainedFrames:undefined,monitorFrames:Number.isFinite(detail.monitorFrames)?detail.monitorFrames:undefined,calibrationComplete:detail.calibrationComplete?1:0,ttsChunkIndex:Number.isInteger(interruptedCheckpoint?.chunkIndex)?interruptedCheckpoint.chunkIndex:undefined})});
  const armBargeMonitor = () => capture.watchForBargeIn((detail)=>interrupt(detail),{onDiagnostic:reportBargeDiagnostic});

  function listen({ afterAudio = false, interruptionProbe = false } = {}) {
    if (!active) return; clearRetry(); if(!interruptionProbe){abortPending();playback.stop();interruptionPlayback.stop?.();}
    const current = generation; publish("getting_ready");
    capture.listen({
      onReady: () => {
        if (!valid(current)) return;
        mark("listeningReadyAt"); publish(pausedWaiting()?"paused_waiting_for_user":"listening");
        if (afterAudio) reportTiming("listening-ready");
      },
      onAudio: (recording) => processRecording(recording,{interruptionProbe}),
      onNoSpeech: () => interruptionProbe?(pausedWaiting()?listen({interruptionProbe:true}):resumeInterrupted({message:"No valid speech detected. Resuming Nova."})):retry("No speech detected."),
      onError: (error) => fatal(error?.message || "Microphone recording failed."),
      onEndpoint: ({ phase, graceMs }) => { if (valid(current)) publish(pausedWaiting()?"paused_waiting_for_user":"listening", { phase: phase === "possible-end" ? "endpoint-grace" : "speech-resumed", graceMs }); }
    });
  }

  function retry(message, delayMs = retryDelayMs, { preserveCheckpoint = false } = {}) {
    if (!active) return; clearRetry(); publish("retrying"); onNotice(message);
    retryTimer = schedule(() => { retryTimer = undefined; if (active) listen(preserveCheckpoint ? { interruptionProbe: true } : {}); }, delayMs);
  }

  function recover(message, delayMs = retryDelayMs) {
    if (!active) return; abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message); reportTiming("error"); retry("Voice is recovering…", delayMs);
  }

  function fatal(message) {
    active = false; generation += 1; clearRetry(); abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message); reportTiming("fatal-error");
  }

  async function processRecording(recording,{interruptionProbe=false}={}) {
    if (!active || !["listening","paused_waiting_for_user"].includes(state)) return false;
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
      if(Number.isFinite(transcribed?.timing?.sttMs))timing.sttServerMs=transcribed.timing.sttMs;
      if(Number.isFinite(transcribed?.timing?.sttAndSpeakerMs))timing.sttAndSpeakerServerMs=transcribed.timing.sttAndSpeakerMs;
      const text = String(transcript || "").trim();
      if(interruptedCheckpoint&&isContinueIntent(text))return resumeInterrupted({speaker,text,message:"Continuing Nova's interrupted response.",explicit:true});
      if (!text) { if(pausedWaiting()){listen({interruptionProbe:true});return false;} retry("No speech was understood."); return false; }
      let preservingCheckpoint=interruptionProbe&&canPreserveCheckpoint(speaker,interruptedCheckpoint);
      const pauseIntent=preservingCheckpoint&&isPauseIntent(text);
      if(pauseIntent)interruptedCheckpoint={...interruptedCheckpoint,status:"paused_waiting_for_user",pausedAt:now()};
      else if(pausedWaiting()){interruptedCheckpoint=undefined;playback.stop();current=++generation;preservingCheckpoint=false;}
      if(interruptionProbe&&!preservingCheckpoint){interruptedCheckpoint=undefined;playback.stop();current=++generation;}
      if(interruptionProbe){abortPending();abortController=new AbortController();}
      onTranscript(text); publish("thinking"); mark("agentRequestStartedAt");
      const result = await sendTurn(text, {
        signal: abortController.signal,
        speaker,
        prepareAssistant: async (message,assistantResult) => {
          if (!valid(current)) throw abortError();
          if(assistantResult?.timing){timing.contextRetrievalMs=assistantResult.timing.contextRetrievalMs;timing.preModelMs=assistantResult.timing.preModelMs;timing.agentFirstResponseMs=assistantResult.timing.agentFirstResponseMs;timing.agentCompleteMs=assistantResult.timing.agentCompleteMs;}
          mark("assistantAvailableAt"); publish("speaking", { phase: "preparing-audio" });
          if(!preservingCheckpoint)interruptedCheckpoint={assistantTurnId:assistantResult?.id||`voice-${turnSequence}`,message,conversationId:assistantResult?.conversationId||null,createdAt:now(),chunkIndex:0,speakerProfileId:confirmedProfileId(speaker),continuationVersion:1,status:"active"};
           else interruptedCheckpoint={...interruptedCheckpoint,lastVerifiedInterruptionProfileId:confirmedProfileId(speaker)||interruptedCheckpoint.lastVerifiedInterruptionProfileId,acknowledgedAt:now(),status:pauseIntent?"paused_waiting_for_user":"interrupted"};
          mark("ttsStartedAt");
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
      const targetPlayback=preservingCheckpoint?interruptionPlayback:playback;
      targetPlayback.play(speech.stream || speech.audio, {
        onStarted: () => { if (valid(current)) { armBargeMonitor();mark("audioStartedAt"); reportTiming("audio-started"); } },
        onChunkStarted:({index,chunkCount,currentChunkText}={})=>{if(!preservingCheckpoint&&interruptedCheckpoint&&Number.isInteger(index))interruptedCheckpoint={...interruptedCheckpoint,chunkIndex:index,chunkCount:Number.isInteger(chunkCount)?chunkCount:interruptedCheckpoint.chunkCount,currentChunkText:typeof currentChunkText==="string"?currentChunkText:interruptedCheckpoint.currentChunkText,status:"active"};},
        onEnded: () => { if (valid(current)) { mark("audioEndedAt"); if(preservingCheckpoint)listen({afterAudio:true,interruptionProbe:true});else{if(interruptedCheckpoint)interruptedCheckpoint={...interruptedCheckpoint,status:"completed",completedAt:now()};interruptedCheckpoint=undefined;listen({ afterAudio: true });} } },
        onError: (error) => { if (valid(current)) recover(voiceFailureMessage(error, true), ttsRecoveryDelayMs); }
      });
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || !valid(current)) return false;
      recover(state === "transcribing" ? "Nova could not transcribe that turn. Please try again." : error?.message || "Nova could not complete that voice turn."); return false;
    }
  }

  function interrupt(detail={}) {
    if (!active || state !== "speaking") return false;
    if(Number.isFinite(detail?.speechOnsetAt))timing.bargeSpeechOnsetAt=detail.speechOnsetAt;if(Number.isFinite(detail?.detectedAt))timing.bargeDetectedAt=detail.detectedAt;timing.bargeVoicedMs=detail?.voicedMs;timing.bargeBaselineRms=detail?.baselineRms;timing.bargeThresholdRms=detail?.thresholdRms;timing.bargePeakRms=detail?.peakRms;timing.bargeSustainedFrames=detail?.sustainedFrames;timing.bargeMonitorFrames=detail?.monitorFrames;timing.bargeCalibrationComplete=detail?.calibrationComplete?1:0;timing.bargeTtsChunkIndex=interruptedCheckpoint?.chunkIndex;
    clearRetry();const playbackState=playback.checkpoint?.();
    if(!playbackState){generation+=1;abortPending();playback.stop();mark("bargePlaybackStoppedAt");reportTiming("interrupted");capture.stop();publish("interrupted");listen();return true;}
    playback.pause?.();mark("bargePlaybackStoppedAt");reportTiming("interrupted");interruptedCheckpoint={...(interruptedCheckpoint||{}),playback:playbackState,chunkIndex:Number.isInteger(playbackState.chunkIndex)?playbackState.chunkIndex:interruptedCheckpoint?.chunkIndex,lastFullyPlayedChunk:Number.isInteger(playbackState.lastFullyPlayedChunk)?playbackState.lastFullyPlayedChunk:interruptedCheckpoint?.lastFullyPlayedChunk,chunkCount:Number.isInteger(playbackState.chunkCount)?playbackState.chunkCount:interruptedCheckpoint?.chunkCount,currentChunkText:playbackState.currentChunkText||interruptedCheckpoint?.currentChunkText,interruptedAt:now(),continuationVersion:(interruptedCheckpoint?.continuationVersion||0)+1,status:interruptedCheckpoint?.resumeCount?"interrupted_again":"interrupted"};capture.stop();publish("interrupted");listen({interruptionProbe:true});return true;
  }

  function resumeInterrupted({speaker,text,message,explicit=false}={}){
    if(!active||!interruptedCheckpoint||now()-(interruptedCheckpoint.interruptedAt||interruptedCheckpoint.createdAt)>checkpointTtlMs){interruptedCheckpoint=undefined;retry(message||"Nothing recent is available to continue.");return false;}
    if(pausedWaiting()&&!explicit)return false;
    if(text&&!resumeAuthorized(speaker,interruptedCheckpoint)){retry("Nova could not verify that this continuation belongs to the interrupted speaker.",retryDelayMs,{preserveCheckpoint:true});return false;}
    interruptionPlayback.stop?.();
    capture.stop();interruptedCheckpoint={...interruptedCheckpoint,resumedAt:now(),resumeCount:(interruptedCheckpoint.resumeCount||0)+1};publish("speaking",{phase:"resuming",assistantTurnId:interruptedCheckpoint.assistantTurnId,chunkIndex:interruptedCheckpoint.chunkIndex});mark("resumeRequestedAt");
    if(!playback.resume?.({onStarted:()=>{mark("resumePlaybackStartedAt");reportTiming("resume-audio-started");}})){interruptedCheckpoint=undefined;retry("The interrupted audio is no longer available.");return false;}
    armBargeMonitor();onNotice(message);return true;
  }

  return Object.freeze({
    async start() {
      if (active) return false; active = true; const current = ++generation; publish("connecting");
      try { await capture.connect(); if (!valid(current)) { await capture.destroy(); return false; } listen(); return true; }
      catch (error) { if (!valid(current)) { await capture.destroy(); return false; } fatal(error?.message || "Microphone permission was denied or no microphone is available."); return false; }
    },
    end() { if (!active && state === "idle") return; active = false; generation += 1; interruptedCheckpoint=undefined;clearRetry(); abortPending(); capture.stop(); playback.stop(); interruptionPlayback.stop?.(); Promise.resolve(capture.destroy()).catch(() => {}); publish("idle"); },
    interrupt,
    isActive: () => active,
    getState: () => state,
    getLastTiming: () => timing ? timingSnapshot(timing, "snapshot") : null,
    getInterruptedCheckpoint:()=>interruptedCheckpoint?{assistantTurnId:interruptedCheckpoint.assistantTurnId,conversationId:interruptedCheckpoint.conversationId,originalText:interruptedCheckpoint.message,chunkIndex:interruptedCheckpoint.chunkIndex,lastFullyPlayedChunk:interruptedCheckpoint.lastFullyPlayedChunk,chunkCount:interruptedCheckpoint.chunkCount,remainingChunkCount:Number.isInteger(interruptedCheckpoint.chunkCount)?Math.max(0,interruptedCheckpoint.chunkCount-(Number.isInteger(interruptedCheckpoint.lastFullyPlayedChunk)?interruptedCheckpoint.lastFullyPlayedChunk+1:0)):undefined,currentChunkText:interruptedCheckpoint.currentChunkText,currentTime:interruptedCheckpoint.playback?.currentTime,interruptedAt:interruptedCheckpoint.interruptedAt,continuationVersion:interruptedCheckpoint.continuationVersion,status:interruptedCheckpoint.status,resumeCount:interruptedCheckpoint.resumeCount||0}:null
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
      uploadNetworkAndEncoding: Number.isFinite(timing.sttAndSpeakerServerMs)&&Number.isFinite(timing.transcriptAvailableAt)&&Number.isFinite(timing.sttStartedAt)?rounded((timing.transcriptAvailableAt-timing.sttStartedAt)-timing.sttAndSpeakerServerMs):undefined,
      sttServer: timing.sttServerMs,
      sttAndSpeakerServer: timing.sttAndSpeakerServerMs,
      speakerRecognition: timing.speakerRecognitionMs,
      contextRetrieval: timing.contextRetrievalMs,
      preModel: timing.preModelMs,
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
      audioEndToListening: difference("listeningReadyAt", "audioEndedAt"),
      resumeRequestToPlayback: difference("resumePlaybackStartedAt","resumeRequestedAt"),
      bargeSpeechToPlaybackStop: difference("bargePlaybackStoppedAt","bargeSpeechOnsetAt"),
      bargeDetection: difference("bargeDetectedAt","bargeSpeechOnsetAt"),
      bargeVoiced: Number.isFinite(timing.bargeVoicedMs)?timing.bargeVoicedMs:undefined,
      bargeBaselineRms: Number.isFinite(timing.bargeBaselineRms)?precise(timing.bargeBaselineRms):undefined,
      bargeThresholdRms: Number.isFinite(timing.bargeThresholdRms)?precise(timing.bargeThresholdRms):undefined,
      bargePeakRms: Number.isFinite(timing.bargePeakRms)?precise(timing.bargePeakRms):undefined,
      bargeSustainedFrames: Number.isFinite(timing.bargeSustainedFrames)?timing.bargeSustainedFrames:undefined,
      bargeMonitorFrames: Number.isFinite(timing.bargeMonitorFrames)?timing.bargeMonitorFrames:undefined,
      bargeCalibrationComplete: Number.isFinite(timing.bargeCalibrationComplete)?timing.bargeCalibrationComplete:undefined,
      bargeTtsChunkIndex: Number.isInteger(timing.bargeTtsChunkIndex)?timing.bargeTtsChunkIndex:undefined
    })
  });
}

function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function rounded(value) { return Math.round(Math.max(0, value) * 10) / 10; }
function precise(value){return Math.round(Math.max(0,value)*100000)/100000;}
function abortError() { const error = new Error("Voice turn was interrupted."); error.name = "AbortError"; return error; }
function isContinueIntent(text){const value=String(text||"").normalize("NFKD").replace(/[\u064B-\u065F\u0670]/gu,"").trim();return /\b(?:continue|go on|carry on|resume)(?:\s+(?:from\s+where\s+you\s+(?:stopped|left\s+off)|the\s+same\s+point))?\b/iu.test(value)||/(?:^|[\s،,.؟?])(?:ارجع|ارجعي|رجع|رجعي|يلا)?\s*(?:كمل(?:ي|لي|يلي|يليلي)?|لنفس\s+النقط[هة]|من\s+(?:وين\s+وقفتي|عند\s+ما\s+تركتي)|شو\s+كنتي\s+تحكي)(?:$|[\s،,.؟?])/iu.test(value);}
function isPauseIntent(text){const value=String(text||"").normalize("NFKD").replace(/[\u064B-\u065F\u0670]/gu,"").trim();return /(?:^|[\s،,.؟?])(?:استن(?:ي|ى)|لحظ[هة]|دقيق[هة]|وقف(?:ي)?|وقف[هة]|خلاص|wait|hold on|stop|one second|pause)(?:$|[\s،,.؟?])/iu.test(value);}
function confirmedProfileId(speaker){return speaker?.match_status==="confirmed"&&typeof speaker?.speaker_profile_id==="string"?speaker.speaker_profile_id:null;}
function canPreserveCheckpoint(speaker,checkpoint){const profileId=confirmedProfileId(speaker);return Boolean(checkpoint&&((profileId&&profileId===checkpoint.speakerProfileId)||(speaker?.match_status==="insufficient_speech"&&checkpoint.speakerProfileId)));}
function resumeAuthorized(speaker,checkpoint){const profileId=confirmedProfileId(speaker);if(profileId)return profileId===checkpoint.speakerProfileId;return speaker?.match_status==="insufficient_speech"&&checkpoint.lastVerifiedInterruptionProfileId===checkpoint.speakerProfileId;}
function voiceFailureMessage(error,browserFallback=false){if(error?.category==="quota")return "Nova's written reply is safe, but ElevenLabs credits are exhausted.";if(error?.category==="authentication")return "Nova's written reply is safe, but ElevenLabs authentication needs attention.";if(error?.category==="voice_access")return "Nova's written reply is safe, but the selected ElevenLabs voice is unavailable.";if(error?.category==="rate_limit")return "Nova's written reply is safe, but ElevenLabs is temporarily busy.";if(["provider_timeout_first_byte","provider_stream_stalled"].includes(error?.category))return "Nova's written reply is safe, but ElevenLabs audio timed out.";if(error?.message&&/written reply is safe/i.test(error.message))return error.message;return browserFallback?"Nova's written reply is safe, but audio playback failed.":"Nova's written reply is safe, but ElevenLabs could not speak it.";}
