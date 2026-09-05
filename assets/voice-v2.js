import {createVoiceControl} from "./voice-control.js";

export function createVoiceV2({
  capture, client, playback, interruptionPlayback = playback, sendTurn,
  onTranscript = () => {}, onState = () => {}, onError = () => {}, onNotice = () => {}, onTiming = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay), cancelSchedule = (timer) => clearTimeout(timer),
  now = () => globalThis.performance?.now?.() ?? Date.now(), retryDelayMs = 900, ttsRecoveryDelayMs = 250, checkpointTtlMs = 120_000, provisionalDuckMs = 350
}) {
  let active = false; let state = "idle"; let generation = 0; let retryTimer;let provisionalDuckTimer; let abortController; let turnSequence = 0; let timing;let acceptedVoiceTurns=0;let assistantAskedQuestion=false;let contextualReplyUntil=0;const voiceControl=createVoiceControl({now,ttlMs:checkpointTtlMs});
  const publish = (next, detail = {}) => { state = next; onState({ active, state, ...detail }); };
  const clearRetry = () => { if (retryTimer !== undefined) cancelSchedule(retryTimer); retryTimer = undefined; };
  const clearProvisionalDuck = () => { if(provisionalDuckTimer!==undefined)cancelSchedule(provisionalDuckTimer);provisionalDuckTimer=undefined; };
  const abortPending = () => { abortController?.abort(); abortController = undefined; };
  const valid = (current) => active && current === generation;
  const mark = (name, value = now()) => { if (timing) timing[name] = value; };
  const reportTiming = (stage) => { if (timing) onTiming(timingSnapshot(timing, stage)); };
  const reportRelevance = (relevance,speaker) => onTiming({turnId:timing?.turnId,stage:`relevance-${relevance?.category||"unknown"}`,measurements:{acceptedAsTurn:relevance?.accepted_as_turn?1:0,relevanceConfidence:Number.isFinite(relevance?.confidence)?relevance.confidence:0,ownerSpeaker:speaker?.authenticated_identity==="owner"?1:0}});
  const pausedWaiting = () => voiceControl.isPaused();
  const reportBargeDiagnostic = (detail = {}) => onTiming({turnId:timing?.turnId,stage:`barge-${detail.phase||"candidate"}`,measurements:compact({speechOnset:Number.isFinite(detail.speechOnsetAt)?rounded(detail.speechOnsetAt):undefined,baselineRms:Number.isFinite(detail.baselineRms)?precise(detail.baselineRms):undefined,thresholdRms:Number.isFinite(detail.thresholdRms)?precise(detail.thresholdRms):undefined,peakUserRms:Number.isFinite(detail.peakRms)?precise(detail.peakRms):undefined,sustainedFrames:Number.isFinite(detail.sustainedFrames)?detail.sustainedFrames:undefined,monitorFrames:Number.isFinite(detail.monitorFrames)?detail.monitorFrames:undefined,calibrationComplete:detail.calibrationComplete?1:0,ttsChunkIndex:Number.isInteger(voiceControl.current()?.chunkIndex)?voiceControl.current().chunkIndex:undefined})});
  const armBargeMonitor = () => capture.watchForBargeIn((detail)=>interrupt(detail),{onDiagnostic:reportBargeDiagnostic});

  function listen({ afterAudio = false, interruptionProbe = false, reuseCandidateCapture = false } = {}) {
    if (!active) return; clearRetry(); if(!interruptionProbe){abortPending();playback.stop();interruptionPlayback.stop?.();}
    const current = generation; publish(interruptionProbe?"barge_candidate":"getting_ready");
    capture.listen({
      interruptionProbe,
      reuseCandidateCapture,
      onReady: () => {
        if (!valid(current)) return;
        mark("listeningReadyAt"); publish(pausedWaiting()?"paused_waiting_for_user":interruptionProbe?"barge_verifying":"listening");onTiming({turnId:timing?.turnId||null,stage:"capture-listener-ready",measurements:{listenerArmed:1,interruptionProbe:interruptionProbe?1:0}});
        if(interruptionProbe)onTiming({turnId:timing?.turnId,stage:"control-listener-ready",measurements:{paused:pausedWaiting()?1:0,reusedCandidate:reuseCandidateCapture?1:0}});
        if (afterAudio) reportTiming("listening-ready");
      },
      onAudio: (recording) => processRecording(recording,{interruptionProbe}),
      onNoSpeech: () => interruptionProbe?(pausedWaiting()?listen({interruptionProbe:true}):resumeInterrupted({message:"No valid speech detected. Resuming Nova.",quiet:true})):retry("No speech detected."),
      onError: (error) => fatal(error?.message || "Microphone recording failed."),
      onEndpoint: ({ phase, graceMs }) => { if (valid(current)) publish(pausedWaiting()?"paused_waiting_for_user":interruptionProbe?"barge_verifying":"listening", { phase: phase === "possible-end" ? "endpoint-grace" : "speech-resumed", graceMs }); }
    });
  }

  function retry(message, delayMs = retryDelayMs, { preserveCheckpoint = false } = {}) {
    if (!active) return; clearRetry(); publish("retrying"); onNotice(message);
    retryTimer = schedule(() => { retryTimer = undefined; if (active) listen(preserveCheckpoint ? { interruptionProbe: true } : {}); }, delayMs);
  }

  function recover(message, delayMs = retryDelayMs) {
    if (!active) return; clearProvisionalDuck();abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message); reportTiming("error"); retry("Voice is recovering…", delayMs);
  }

  function fatal(message) {
    active = false; generation += 1; clearRetry();clearProvisionalDuck(); abortPending(); capture.stop(); playback.stop(); publish("error"); onError(message); reportTiming("fatal-error");
  }

  async function processRecording(recording,{interruptionProbe=false}={}) {
    if (!active || !["listening","barge_verifying","paused_waiting_for_user"].includes(state)) return false;
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
    mark("sttStartedAt"); publish(interruptionProbe?"barge_verifying":"transcribing");
    try {let routeAsConversation=false;
      if(interruptionProbe&&voiceControl.current()){
        let controlResult;try{controlResult=await client.control({...recording,signal:abortController.signal,lifecycleState:pausedWaiting()?"paused_waiting_for_user":"speaking"});}catch(error){if(!valid(current))return false;if(pausedWaiting()){onTiming({turnId:timing?.turnId,stage:"control-stt-failed",measurements:{checkpointPreserved:1}});listen({interruptionProbe:true});return false;}resumeInterrupted({message:"Control audio was unclear. Resuming Nova.",quiet:true,controlAuthorized:true});return false;}
        if(!valid(current))return false;const controlIntent=controlResult?.control?.intent||"uncertain";const controlText=String(controlResult?.transcript||"").trim();onTiming({turnId:timing?.turnId,stage:`control-intent-${controlIntent}`,measurements:{checkpointPresent:1,paused:pausedWaiting()?1:0,confidence:Number(controlResult?.control?.confidence)||0}});
        if(controlIntent==="pause"&&!pausedWaiting()){clearProvisionalDuck();playback.unduck?.();playback.pause?.();voiceControl.update({status:"paused_waiting_for_user",pausedAt:now(),pauseAuthorization:"playback_control",playbackCompletedDuringVerification:false});onTranscript(controlText);onTiming({turnId:timing?.turnId,stage:"barge-playback-control-pause",measurements:{playbackOnly:1,identityUpgraded:0,privateContextEnabled:0}});onTiming({turnId:timing?.turnId,stage:"control-pause-committed",measurements:{playbackOnly:1,identityUpgraded:0,privateContextEnabled:0}});listen({interruptionProbe:true});return true;}
        if(controlIntent==="resume"&&pausedWaiting())return resumeInterrupted({text:controlText,explicit:true,quiet:true,controlAuthorized:true});
        if(["unrelated","uncertain"].includes(controlIntent)){if(pausedWaiting()){listen({interruptionProbe:true});return false;}resumeInterrupted({message:"Background audio ignored. Resuming Nova.",quiet:true,controlAuthorized:true});return false;}
        if(controlIntent==="new_conversation"){voiceControl.clear();playback.stop();routeAsConversation=true;}
      }
      const transcribed = await client.transcribe({ ...recording, signal: abortController.signal,relevanceContext:{interruption:interruptionProbe&&!routeAsConversation,playback_control_expected:false,playback_paused:false,awaiting_nova_reply:!interruptionProbe&&contextualReplyUntil>0&&now()<=contextualReplyUntil,voice_session_engaged:acceptedVoiceTurns>0} });
      const { transcript, speaker } = transcribed;
      if (!valid(current)) return false;
      mark("transcriptAvailableAt");
      if(Number.isFinite(transcribed?.timing?.speakerRecognitionMs))timing.speakerRecognitionMs=transcribed.timing.speakerRecognitionMs;
      if(Number.isFinite(transcribed?.timing?.sttMs))timing.sttServerMs=transcribed.timing.sttMs;
      if(Number.isFinite(transcribed?.timing?.sttAndSpeakerMs))timing.sttAndSpeakerServerMs=transcribed.timing.sttAndSpeakerMs;
      const text = String(transcript || "").trim();
      const relevance=transcribed?.relevance||{category:"addressed_to_nova",accepted_as_turn:true,reason:"legacy_client_compatibility"};
      if(!relevance.accepted_as_turn){reportRelevance(relevance,speaker);if(interruptionProbe){if(pausedWaiting())listen({interruptionProbe:true});else resumeInterrupted({message:"Background audio ignored. Resuming Nova.",quiet:true,controlAuthorized:true});}else listen();return false;}
      acceptedVoiceTurns+=1;contextualReplyUntil=0;reportRelevance(relevance,speaker);
      if(interruptionProbe&&!routeAsConversation){clearProvisionalDuck();const playbackCompleted=voiceControl.current()?.playbackCompletedDuringVerification===true;playback.unduck?.();playback.pause?.();if(playbackCompleted)voiceControl.clear();}
      if (!text) { if(pausedWaiting()){listen({interruptionProbe:true});return false;} retry("No speech was understood."); return false; }
      let preservingCheckpoint=interruptionProbe&&!routeAsConversation&&canPreserveCheckpoint(speaker,voiceControl.current());
      if(pausedWaiting()){voiceControl.clear();playback.stop();current=++generation;preservingCheckpoint=false;}
      if(interruptionProbe&&!preservingCheckpoint){voiceControl.clear();playback.stop();current=++generation;}
      if(interruptionProbe){abortPending();abortController=new AbortController();}
      onTranscript(text); publish("thinking"); mark("agentRequestStartedAt");
      const result = await sendTurn(text, {
        signal: abortController.signal,
        speaker,
        prepareAssistant: async (message,assistantResult) => {
          if (!valid(current)) throw abortError();
          if(assistantResult?.timing){timing.contextRetrievalMs=assistantResult.timing.contextRetrievalMs;timing.preModelMs=assistantResult.timing.preModelMs;timing.agentFirstResponseMs=assistantResult.timing.agentFirstResponseMs;timing.agentCompleteMs=assistantResult.timing.agentCompleteMs;}
          mark("assistantAvailableAt");assistantAskedQuestion=looksLikeQuestion(message);publish("speaking", { phase: "preparing-audio" });
          if(!preservingCheckpoint)voiceControl.replace({assistantTurnId:assistantResult?.id||`voice-${turnSequence}`,message,conversationId:assistantResult?.conversationId||null,createdAt:now(),chunkIndex:0,speakerProfileId:confirmedProfileId(speaker),ownerBoundOrigin:Boolean(confirmedProfileId(speaker)),continuationVersion:1,status:"active"});
           else voiceControl.update({lastVerifiedInterruptionProfileId:confirmedProfileId(speaker)||voiceControl.current()?.lastVerifiedInterruptionProfileId,acknowledgedAt:now(),status:"interrupted"});
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
        onChunkStarted:({index,chunkCount,currentChunkText}={})=>{if(!preservingCheckpoint&&voiceControl.current()&&Number.isInteger(index))voiceControl.update({chunkIndex:index,chunkCount:Number.isInteger(chunkCount)?chunkCount:voiceControl.current().chunkCount,currentChunkText:typeof currentChunkText==="string"?currentChunkText:voiceControl.current().currentChunkText,status:"active"});},
        onEnded: () => { if (valid(current)) { mark("audioEndedAt");if(voiceControl.current()?.status==="control_candidate"){voiceControl.update({playbackCompletedDuringVerification:true,completedAt:now()});return;} if(preservingCheckpoint)listen({afterAudio:true,interruptionProbe:true});else{contextualReplyUntil=assistantAskedQuestion?now()+20_000:0;voiceControl.clear();listen({ afterAudio: true });} } },
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
    if(Number.isFinite(detail?.speechOnsetAt))timing.bargeSpeechOnsetAt=detail.speechOnsetAt;if(Number.isFinite(detail?.detectedAt))timing.bargeDetectedAt=detail.detectedAt;timing.bargeVoicedMs=detail?.voicedMs;timing.bargeBaselineRms=detail?.baselineRms;timing.bargeThresholdRms=detail?.thresholdRms;timing.bargePeakRms=detail?.peakRms;timing.bargeSustainedFrames=detail?.sustainedFrames;timing.bargeMonitorFrames=detail?.monitorFrames;timing.bargeCalibrationComplete=detail?.calibrationComplete?1:0;timing.bargeTtsChunkIndex=voiceControl.current()?.chunkIndex;
    clearRetry();const playbackState=playback.checkpoint?.();
    if(!playbackState){generation+=1;abortPending();playback.stop();mark("bargePlaybackStoppedAt");reportTiming("interrupted");capture.stop();publish("interrupted");listen();return true;}
    const previous=voiceControl.current()||{};const ducked=playback.duck?.(.18);if(!ducked)playback.pause?.();mark("bargePlaybackStoppedAt");reportTiming("interrupted");voiceControl.replace({...previous,playback:playbackState,chunkIndex:Number.isInteger(playbackState.chunkIndex)?playbackState.chunkIndex:previous.chunkIndex,lastFullyPlayedChunk:Number.isInteger(playbackState.lastFullyPlayedChunk)?playbackState.lastFullyPlayedChunk:previous.lastFullyPlayedChunk,chunkCount:Number.isInteger(playbackState.chunkCount)?playbackState.chunkCount:previous.chunkCount,currentChunkText:playbackState.currentChunkText||previous.currentChunkText,interruptedAt:now(),continuationVersion:(previous.continuationVersion||0)+1,status:"control_candidate"});if(ducked){clearProvisionalDuck();const duckStartedAt=now();provisionalDuckTimer=schedule(()=>{provisionalDuckTimer=undefined;if(active&&voiceControl.current()?.status==="control_candidate"&&["barge_candidate","barge_verifying"].includes(state)){playback.unduck?.();onTiming({turnId:timing?.turnId,stage:"barge-provisional-unduck",measurements:{duckMs:rounded(now()-duckStartedAt),candidatePending:1}});}},provisionalDuckMs);}if(!detail.capturePrimed)capture.stop();publish("barge_candidate");listen({interruptionProbe:true,reuseCandidateCapture:Boolean(detail.capturePrimed)});return true;
  }

  function resumeInterrupted({speaker,text,message,explicit=false,allowPlaybackContinuity=false,controlAuthorized=false,quiet=false}={}){
    clearProvisionalDuck();const checkpoint=voiceControl.current();
    if(!active||!checkpoint||!voiceControl.isFresh()){voiceControl.clear();retry(message||"Nothing recent is available to continue.");return false;}
    if(checkpoint.playbackCompletedDuringVerification){voiceControl.clear();capture.stop();listen({afterAudio:true});return false;}
    if(pausedWaiting()&&!explicit)return false;
    if(text&&!controlAuthorized&&!resumeAuthorized(speaker,checkpoint,{allowPlaybackContinuity})){onTiming({turnId:timing?.turnId,stage:"control-resume-rejected",measurements:{checkpointPreserved:1,identityUpgraded:0,privateContextEnabled:0}});retry("Nova could not verify that this continuation belongs to the interrupted speaker.",retryDelayMs,{preserveCheckpoint:true});return false;}
    interruptionPlayback.stop?.();capture.stop();voiceControl.update({status:"active",resumedAt:now(),resumeCount:(checkpoint.resumeCount||0)+1});const resumed=voiceControl.current();publish("speaking",{phase:"resuming",assistantTurnId:resumed.assistantTurnId,chunkIndex:resumed.chunkIndex});mark("resumeRequestedAt");
    const onRestored=()=>{mark("resumePlaybackStartedAt");reportTiming("resume-audio-started");};const restored=playback.unduck?.();
    if(restored)onRestored();else if(!playback.resume?.({onStarted:onRestored})){voiceControl.clear();retry("The interrupted audio is no longer available.");return false;}
    armBargeMonitor();if(text)onTiming({turnId:timing?.turnId,stage:"control-resume-committed",measurements:{playbackOnly:1,identityUpgraded:0,privateContextEnabled:0}});if(!quiet)onNotice(message);return true;
  }

  return Object.freeze({
    async start() {
      if (active) return false; active = true; const current = ++generation; publish("connecting");
      try { const audioSettings=await capture.connect();if(audioSettings&&typeof audioSettings==="object")onTiming({turnId:null,stage:"capture-settings",measurements:{settingsReported:1,trackLive:audioSettings.trackLive===true?1:0,trackEnabled:audioSettings.trackEnabled===true?1:0,echoCancellation:audioSettings.echoCancellation===true?1:0,noiseSuppression:audioSettings.noiseSuppression===true?1:0,autoGainControl:audioSettings.autoGainControl===true?1:0,...(Number.isFinite(audioSettings.sampleRate)?{sampleRate:audioSettings.sampleRate}:{}),...(Number.isFinite(audioSettings.channelCount)?{channelCount:audioSettings.channelCount}:{})}}); if (!valid(current)) { await capture.destroy(); return false; } listen(); return true; }
      catch (error) { if (!valid(current)) { await capture.destroy(); return false; } fatal(error?.message || "Microphone permission was denied or no microphone is available."); return false; }
    },
    end() { if (!active && state === "idle") return; active = false; generation += 1; voiceControl.clear();acceptedVoiceTurns=0;assistantAskedQuestion=false;contextualReplyUntil=0;clearRetry();clearProvisionalDuck(); abortPending(); capture.stop(); playback.stop(); interruptionPlayback.stop?.(); Promise.resolve(capture.destroy()).catch(() => {}); publish("idle"); },
    interrupt,
    isActive: () => active,
    getState: () => state,
    getLastTiming: () => timing ? timingSnapshot(timing, "snapshot") : null,
    getInterruptedCheckpoint:()=>{const checkpoint=voiceControl.current();return checkpoint?{assistantTurnId:checkpoint.assistantTurnId,conversationId:checkpoint.conversationId,originalText:checkpoint.message,chunkIndex:checkpoint.chunkIndex,lastFullyPlayedChunk:checkpoint.lastFullyPlayedChunk,chunkCount:checkpoint.chunkCount,remainingChunkCount:Number.isInteger(checkpoint.chunkCount)?Math.max(0,checkpoint.chunkCount-(Number.isInteger(checkpoint.lastFullyPlayedChunk)?checkpoint.lastFullyPlayedChunk+1:0)):undefined,currentChunkText:checkpoint.currentChunkText,currentTime:checkpoint.playback?.currentTime,interruptedAt:checkpoint.interruptedAt,continuationVersion:checkpoint.continuationVersion,status:checkpoint.status,resumeCount:checkpoint.resumeCount||0}:null;}
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
function looksLikeQuestion(text){const value=String(text||"").trim();return /[?؟]\s*$/.test(value)||/(?:^|[\s،])(?:شو|ماذا|مين|من|وين|اين|أين|متى|ليش|كيف|هل|what|who|where|when|why|how|which|do you|are you|can you)(?:$|[\s،,.؟?])/iu.test(value);}
function confirmedProfileId(speaker){return speaker?.match_status==="confirmed"&&typeof speaker?.speaker_profile_id==="string"?speaker.speaker_profile_id:null;}
function isConfirmedOwner(speaker){return Boolean(confirmedProfileId(speaker)&&(speaker?.authenticated_identity==="owner"||speaker?.speaker_label==="owner"));}
function canPreserveCheckpoint(speaker,checkpoint){const profileId=confirmedProfileId(speaker);return Boolean(checkpoint&&((profileId&&profileId===checkpoint.speakerProfileId)||(speaker?.match_status==="insufficient_speech"&&checkpoint.speakerProfileId)));}
function resumeAuthorized(speaker,checkpoint,{allowPlaybackContinuity=false}={}){const profileId=confirmedProfileId(speaker);if(profileId)return profileId===checkpoint.speakerProfileId;if(speaker?.match_status==="insufficient_speech"&&checkpoint.lastVerifiedInterruptionProfileId===checkpoint.speakerProfileId)return true;return allowPlaybackContinuity&&checkpoint.status==="paused_waiting_for_user"&&Boolean(checkpoint.pauseAuthorization)&&Boolean(checkpoint.speakerProfileId)&&["insufficient_speech","unknown"].includes(speaker?.match_status);}
function voiceFailureMessage(error,browserFallback=false){if(error?.category==="quota")return "Nova's written reply is safe, but ElevenLabs credits are exhausted.";if(error?.category==="authentication")return "Nova's written reply is safe, but ElevenLabs authentication needs attention.";if(error?.category==="voice_access")return "Nova's written reply is safe, but the selected ElevenLabs voice is unavailable.";if(error?.category==="rate_limit")return "Nova's written reply is safe, but ElevenLabs is temporarily busy.";if(["provider_timeout_first_byte","provider_stream_stalled"].includes(error?.category))return "Nova's written reply is safe, but ElevenLabs audio timed out.";if(error?.message&&/written reply is safe/i.test(error.message))return error.message;return browserFallback?"Nova's written reply is safe, but audio playback failed.":"Nova's written reply is safe, but ElevenLabs could not speak it.";}
