export function createMediaVoiceCapture({
  mediaDevices, MediaRecorder, AudioContext,
  schedule = (callback, delay) => setTimeout(callback, delay), cancelSchedule = (timer) => clearTimeout(timer),
  now = () => Date.now(), sampleIntervalMs = 50, endpointSilenceMs = 1_500, shortFragmentSilenceMs = 1_900,
  longUtteranceSilenceMs = 1_300, resumedSpeechBonusMs = 100, maxEndpointSilenceMs = 2_200,
  noSpeechMs = 8_000, maxDurationMs = 30_000, calibrationMs = 400,
  speechThreshold = 0.035, bargeThreshold = 0.025, recorderTimesliceMs = 100, bargeAcousticFrames = 2, bargeSpeechFrames = 3
}) {
  let stream; let context; let analyser; let source; let recorder; let timer; let generation = 0; let listening = false; let primedCapture;let audioSettings={};
  const supported = Boolean(mediaDevices?.getUserMedia && MediaRecorder && AudioContext);
  const clearTimer = () => { if (timer !== undefined) cancelSchedule(timer); timer = undefined; };
  const stopRecorder = () => { if (recorder?.state === "recording") recorder.stop(); recorder = undefined; primedCapture = undefined; listening = false; };
  const rms = () => { const data = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(data); let sum = 0; for (const value of data) { const centered = (value - 128) / 128; sum += centered * centered; } return Math.sqrt(sum / data.length); };

  async function connect() {
    if (!supported) throw new Error("Voice V2 requires microphone recording and audio analysis support.");
    stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const audioTrack=stream.getAudioTracks?.()[0]||stream.getTracks?.().find?.((track)=>track.kind==="audio")||stream.getTracks?.()[0];const reported=audioTrack?.getSettings?.()||{};audioSettings={...(typeof reported.echoCancellation==="boolean"?{echoCancellation:reported.echoCancellation}:{}),...(typeof reported.noiseSuppression==="boolean"?{noiseSuppression:reported.noiseSuppression}:{}),...(typeof reported.autoGainControl==="boolean"?{autoGainControl:reported.autoGainControl}:{}),...(Number.isFinite(reported.sampleRate)?{sampleRate:reported.sampleRate}:{}),...(Number.isFinite(reported.channelCount)?{channelCount:reported.channelCount}:{})};
    context = new AudioContext(); analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2;
    source = context.createMediaStreamSource(stream); source.connect(analyser); if (context.state === "suspended") await context.resume();
    return Object.freeze({...audioSettings});
  }

  function listen({ onReady, onAudio, onNoSpeech, onError, onEndpoint, interruptionProbe = false, reuseCandidateCapture = false }) {
    clearTimer(); const primed = interruptionProbe && reuseCandidateCapture ? primedCapture : undefined; if (!primed) stopRecorder(); primedCapture = undefined; const current = ++generation;
    const activeCalibrationMs = interruptionProbe ? 0 : calibrationMs;
    const activeEndpointSilenceMs = interruptionProbe ? Math.min(endpointSilenceMs, 700) : endpointSilenceMs;
    const activeShortFragmentSilenceMs = interruptionProbe ? Math.min(shortFragmentSilenceMs, 850) : shortFragmentSilenceMs;
    const activeLongUtteranceSilenceMs = interruptionProbe ? Math.min(longUtteranceSilenceMs, 650) : longUtteranceSilenceMs;
    const activeMaxEndpointSilenceMs = interruptionProbe ? Math.min(maxEndpointSilenceMs, 1_000) : maxEndpointSilenceMs;
    const activeNoSpeechMs = interruptionProbe ? Math.min(noSpeechMs, 2_500) : noSpeechMs;
    const activeMaxDurationMs = interruptionProbe ? Math.min(maxDurationMs, 4_000) : maxDurationMs;
    const chunks = primed?.chunks || [];
    let speechFrames = primed ? 2 : 0; let heardSpeech = Boolean(primed); let speechStartedAt = primed?.startedAt || 0; let lastSpeechAt = primed?.lastSpeechAt || 0; let voicedMs = primed?.voicedMs || 0;
    let endpointStartedAt = 0; let endpointGraceMs = 0; let resumedEndpoints = 0; let noiseFloor = 0.008; const startedAt = primed?.startedAt || now();
    try { recorder = primed?.recorder || new MediaRecorder(stream, preferredRecorderOptions(MediaRecorder)); }
    catch (error) { listening = false; onError?.(error); return; }
    const activeRecorder = recorder;
    if (!primed) activeRecorder.addEventListener("dataavailable", (event) => { if (current !== generation || !event.data?.size) return; chunks.push(event.data); });
    activeRecorder.addEventListener("error", (event) => { if (current === generation) onError?.(event.error || new Error("Microphone recording failed.")); });
    activeRecorder.addEventListener("stop", () => {
      if (current !== generation) return;
      clearTimer(); listening = false;
      const endedAt = now(); const durationSeconds = Math.max(0, (endedAt - startedAt) / 1000);
      if (!heardSpeech || !chunks.length) { onNoSpeech?.(); return; }
      onAudio?.({
        audio: new Blob(chunks, { type: activeRecorder.mimeType || "audio/webm" }), mimeType: activeRecorder.mimeType || "audio/webm",
        durationSeconds, endedAt, speechEndedAt: lastSpeechAt || endedAt, endpointStartedAt: endpointStartedAt || undefined,
        endpointGraceMs: endpointStartedAt ? endpointGraceMs : 0, resumedEndpoints
      });
    });
    try { if (!primed) activeRecorder.start(recorderTimesliceMs); listening = activeRecorder.state === "recording"; }
    catch (error) { listening = false; onError?.(error); return; }
    if (!listening) { onError?.(new Error("Microphone recorder did not become ready.")); return; }
    onReady?.({ startedAt });
    const sample = () => {
      if (current !== generation || !listening) return;
      const elapsed = now() - startedAt; const level = rms();
      if(elapsed<activeCalibrationMs&&level<Math.max(0.065,noiseFloor*4)){noiseFloor=Math.min(0.03,noiseFloor*0.75+level*0.25);timer=schedule(sample,sampleIntervalMs);return;}
      if (!heardSpeech) noiseFloor = Math.min(0.03, noiseFloor * 0.92 + level * 0.08);
      if (level >= Math.max(speechThreshold, noiseFloor * 3)) {
        if (endpointStartedAt) {
          resumedEndpoints += 1;
          onEndpoint?.({ phase: "resumed", at: now(), pendingSince: endpointStartedAt, graceMs: endpointGraceMs, resumedEndpoints });
          endpointStartedAt = 0; endpointGraceMs = 0;
        }
        speechFrames += 1; voicedMs += sampleIntervalMs;
        if (speechFrames >= 2) { if (!heardSpeech) speechStartedAt = now() - sampleIntervalMs; heardSpeech = true; lastSpeechAt = now(); }
      } else {
        speechFrames = 0;
        if (heardSpeech && !endpointStartedAt) {
          endpointStartedAt = now();
          endpointGraceMs = adaptiveEndpointSilence({ voicedMs, speechSpanMs: endpointStartedAt - speechStartedAt, resumedEndpoints, endpointSilenceMs:activeEndpointSilenceMs, shortFragmentSilenceMs:activeShortFragmentSilenceMs, longUtteranceSilenceMs:activeLongUtteranceSilenceMs, resumedSpeechBonusMs, maxEndpointSilenceMs:activeMaxEndpointSilenceMs });
          onEndpoint?.({ phase: "possible-end", at: endpointStartedAt, graceMs: endpointGraceMs, resumedEndpoints });
        }
      }
      if (heardSpeech && endpointStartedAt && now() - endpointStartedAt >= endpointGraceMs) { stopRecorder(); return; }
      if (!heardSpeech && elapsed >= activeNoSpeechMs) { stopRecorder(); return; }
      if (elapsed >= activeMaxDurationMs) { stopRecorder(); return; }
      timer = schedule(sample, sampleIntervalMs);
    };
    timer = schedule(sample, sampleIntervalMs);
  }

  function watchForBargeIn(onBargeIn,{onDiagnostic}={}) {
    clearTimer(); const current = ++generation; let acousticFrames = 0; let speechFrames = 0; let baseline = 0.008;let speechOnsetAt;let monitorFrames=0;let peakRms=0;const monitoringStartedAt=now();
    const discardCandidateCapture=()=>{if(primedCapture?.recorder?.state==="recording")primedCapture.recorder.stop();if(recorder===primedCapture?.recorder)recorder=undefined;primedCapture=undefined;};
    const primeCandidateCapture=()=>{if(primedCapture)return;try{const candidateRecorder=new MediaRecorder(stream,preferredRecorderOptions(MediaRecorder));const chunks=[];candidateRecorder.addEventListener("dataavailable",event=>{if(event.data?.size)chunks.push(event.data);});candidateRecorder.start(recorderTimesliceMs);recorder=candidateRecorder;primedCapture={recorder:candidateRecorder,chunks,startedAt:now(),lastSpeechAt:now(),voicedMs:sampleIntervalMs};}catch{discardCandidateCapture();}};
    const sample = () => {
      if (current !== generation) return;
      const level=rms();monitorFrames+=1;peakRms=Math.max(peakRms,level);if(monitorFrames<=2){baseline=Math.min(.035,baseline*.45+level*.55);timer=schedule(sample,sampleIntervalMs);return;}const threshold=Math.max(bargeThreshold,baseline*1.7);const acoustic=level>=threshold;
      if(!acoustic)baseline=Math.min(baseline,baseline*0.94+level*0.06);
      acousticFrames=acoustic?acousticFrames+1:Math.max(0,acousticFrames-2);if(acousticFrames===1)primeCandidateCapture();else if(acoustic&&primedCapture){primedCapture.voicedMs+=sampleIntervalMs;primedCapture.lastSpeechAt=now();}
      if(acousticFrames>=bargeAcousticFrames){if(!speechOnsetAt){speechOnsetAt=now()-(acousticFrames-1)*sampleIntervalMs;onDiagnostic?.({phase:"candidate",speechOnsetAt,baselineRms:baseline,thresholdRms:threshold,peakRms,sustainedFrames:acousticFrames,monitorFrames,calibrationComplete:monitorFrames>=2});}speechFrames=acoustic?speechFrames+1:Math.max(0,speechFrames-1);}else if(!acoustic){if(speechOnsetAt)onDiagnostic?.({phase:"candidate-reset",speechOnsetAt,detectedAt:now(),baselineRms:baseline,thresholdRms:threshold,peakRms,sustainedFrames:speechFrames,monitorFrames,calibrationComplete:monitorFrames>=2});discardCandidateCapture();speechFrames=0;speechOnsetAt=undefined;peakRms=level;}
      if (speechFrames >= bargeSpeechFrames) { clearTimer(); onBargeIn?.({ confirmed:true,capturePrimed:Boolean(primedCapture),voicedMs:speechFrames*sampleIntervalMs,baselineRms:Math.round(baseline*100000)/100000,thresholdRms:Math.round(threshold*100000)/100000,peakRms:Math.round(peakRms*100000)/100000,sustainedFrames:speechFrames,monitorFrames,calibrationComplete:monitorFrames>=2,speechOnsetAt,detectedAt:now(),monitoringStartedAt,echoCancellation:audioSettings.echoCancellation===true }); return; }
      timer = schedule(sample, sampleIntervalMs);
    };
    timer = schedule(sample, sampleIntervalMs);
  }

  function stop() { generation += 1; clearTimer(); stopRecorder(); }
  async function destroy() { stop(); source?.disconnect?.(); for (const track of stream?.getTracks?.() || []) track.stop(); if (context && context.state !== "closed") await context.close(); stream = context = analyser = source = undefined;audioSettings={}; }
  return Object.freeze({ supported, connect, listen, watchForBargeIn, stop, destroy });
}

function adaptiveEndpointSilence({ voicedMs, speechSpanMs, resumedEndpoints, endpointSilenceMs, shortFragmentSilenceMs, longUtteranceSilenceMs, resumedSpeechBonusMs, maxEndpointSilenceMs }) {
  let graceMs = endpointSilenceMs;
  if (voicedMs < 800 || speechSpanMs < 1_200) graceMs = shortFragmentSilenceMs;
  else if (voicedMs >= 2_500 || speechSpanMs >= 4_000) graceMs = longUtteranceSilenceMs;
  graceMs += Math.min(resumedEndpoints, 3) * resumedSpeechBonusMs;
  return Math.min(maxEndpointSilenceMs, graceMs);
}

function preferredRecorderOptions(MediaRecorder) {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) if (MediaRecorder.isTypeSupported?.(mimeType)) return { mimeType, audioBitsPerSecond: 64_000 };
  return { audioBitsPerSecond: 64_000 };
}

export function createAudioPlayback({ Audio, URL }) {
  let player; let objectUrl; let generation = 0; let iterator; let settlePlayback; let paused=false;let volumeScale=1;let resumeWaiter;let pendingResumeStarted;let currentChunkIndex=-1;let lastFullyPlayedChunk=-1;let currentChunkCount;let currentChunkText;
  const clearPlayer = () => { if (player) { player.pause(); player.removeAttribute?.("src"); player.load?.(); } if (objectUrl) URL.revokeObjectURL(objectUrl); player = objectUrl = undefined; };
  const stop = () => { generation += 1; paused=false;volumeScale=1;resumeWaiter?.();resumeWaiter=undefined;pendingResumeStarted=undefined;settlePlayback?.(); settlePlayback = undefined; clearPlayer(); Promise.resolve(iterator?.return?.()).catch(() => {}); iterator = undefined;currentChunkIndex=-1;lastFullyPlayedChunk=-1;currentChunkCount=undefined;currentChunkText=undefined; };
  return Object.freeze({
    play(source, { onStarted, onEnded, onError, onChunkStarted } = {}) {
      stop(); const current = generation; iterator = toAudioStream(source)[Symbol.asyncIterator](); let chunkIndex=0;
      let started = false;
      const run = async () => {
        let item = await iterator.next();
        while (!item.done && current === generation) {
          if(paused)await new Promise(resolve=>{resumeWaiter=resolve;});
          if(current!==generation)return;
          const next = iterator.next().then((value) => ({ value }), (error) => ({ error }));
          await playBlob(item.value, current, () => {
            currentChunkIndex=Number.isInteger(item.value?.novaChunkIndex)?item.value.novaChunkIndex:chunkIndex;currentChunkCount=Number.isInteger(item.value?.novaChunkCount)?item.value.novaChunkCount:currentChunkCount;currentChunkText=typeof item.value?.novaSpokenText==="string"?item.value.novaSpokenText:currentChunkText;
            onChunkStarted?.({index:chunkIndex++,chunkCount:currentChunkCount,currentChunkText});
            if (!started) { started = true; onStarted?.(); }
            pendingResumeStarted?.();pendingResumeStarted=undefined;
          });
          if (current !== generation) return;
          lastFullyPlayedChunk=currentChunkIndex;
          const prefetched = await next; if (prefetched.error) throw prefetched.error; item = prefetched.value;
        }
        if (current === generation) { clearPlayer(); iterator = undefined; onEnded?.(); }
      };
      run().catch((error) => { if (current === generation && error?.name !== "AbortError") { stop(); onError?.(error); } });
    },
    pause(){if(paused||(!player&&!iterator))return false;paused=true;player?.pause();return true;},
    resume({onStarted}={}){if(!paused)return false;paused=false;if(player)Promise.resolve(player.play()).then(()=>onStarted?.()).catch(()=>{});else pendingResumeStarted=onStarted;resumeWaiter?.();resumeWaiter=undefined;return true;},
    duck(level=.18){if(!player&&!iterator)return false;volumeScale=Math.max(0,Math.min(1,Number(level)||.18));if(player)player.volume=volumeScale;return true;},
    unduck(){if(volumeScale===1)return false;volumeScale=1;if(player)player.volume=1;return true;},
    checkpoint(){return player||iterator?{currentTime:Number(player?.currentTime||0),paused,chunkIndex:currentChunkIndex,lastFullyPlayedChunk,chunkCount:currentChunkCount,currentChunkText}:null;},
    stop
  });

  function playBlob(blob, current, onStarted) {
    return new Promise((resolve, reject) => {
      clearPlayer(); objectUrl = URL.createObjectURL(blob); player = new Audio(objectUrl); player.preload = "auto";player.volume=volumeScale;
      const activePlayer = player;
      const release = () => { if (player === activePlayer) clearPlayer(); };
      const settle = (callback) => { if (settlePlayback === cancel) settlePlayback = undefined; callback(); };
      const cancel = () => resolve(); settlePlayback = cancel;
      let began = false;
      const started = () => { if (began || current !== generation) return; began = true; onStarted(); };
      activePlayer.addEventListener("playing", started, { once: true });
      activePlayer.addEventListener("ended", () => { if (current !== generation) return; paused=false; release(); settle(resolve); }, { once: true });
      activePlayer.addEventListener("error", () => { if (current !== generation) return; release(); settle(() => reject(new Error("Audio playback failed."))); }, { once: true });
      Promise.resolve(activePlayer.play()).then(started).catch((error) => { if (current === generation) { release(); settle(() => reject(error)); } });
    });
  }

  function toAudioStream(source) {
    if (source?.[Symbol.asyncIterator]) return source;
    return {
      async *[Symbol.asyncIterator]() {
        if (source) yield source;
      }
    };
  }
}
