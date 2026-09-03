export function createMediaVoiceCapture({
  mediaDevices, MediaRecorder, AudioContext,
  schedule = (callback, delay) => setTimeout(callback, delay), cancelSchedule = (timer) => clearTimeout(timer),
  now = () => Date.now(), sampleIntervalMs = 50, endpointSilenceMs = 1_800, shortFragmentSilenceMs = 2_250,
  longUtteranceSilenceMs = 1_600, resumedSpeechBonusMs = 150, maxEndpointSilenceMs = 2_500,
  noSpeechMs = 8_000, maxDurationMs = 30_000, calibrationMs = 400,
  speechThreshold = 0.035, bargeThreshold = 0.065, recorderTimesliceMs = 100, bargeAcousticFrames = 2, bargeSpeechFrames = 8
}) {
  let stream; let context; let analyser; let source; let recorder; let timer; let generation = 0; let listening = false;
  const supported = Boolean(mediaDevices?.getUserMedia && MediaRecorder && AudioContext);
  const clearTimer = () => { if (timer !== undefined) cancelSchedule(timer); timer = undefined; };
  const stopRecorder = () => { if (recorder?.state === "recording") recorder.stop(); recorder = undefined; listening = false; };
  const rms = () => { const data = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(data); let sum = 0; for (const value of data) { const centered = (value - 128) / 128; sum += centered * centered; } return Math.sqrt(sum / data.length); };

  async function connect() {
    if (!supported) throw new Error("Voice V2 requires microphone recording and audio analysis support.");
    stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    context = new AudioContext(); analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2;
    source = context.createMediaStreamSource(stream); source.connect(analyser); if (context.state === "suspended") await context.resume();
  }

  function listen({ onReady, onAudio, onNoSpeech, onError, onEndpoint }) {
    clearTimer(); stopRecorder(); const current = ++generation;
    const chunks = [];
    let speechFrames = 0; let heardSpeech = false; let speechStartedAt = 0; let lastSpeechAt = 0; let voicedMs = 0;
    let endpointStartedAt = 0; let endpointGraceMs = 0; let resumedEndpoints = 0; let noiseFloor = 0.008; const startedAt = now();
    try { recorder = new MediaRecorder(stream, preferredRecorderOptions(MediaRecorder)); }
    catch (error) { listening = false; onError?.(error); return; }
    const activeRecorder = recorder;
    activeRecorder.addEventListener("dataavailable", (event) => {
      if (current !== generation || !event.data?.size) return;
      chunks.push(event.data);
    });
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
    try { activeRecorder.start(recorderTimesliceMs); listening = activeRecorder.state === "recording"; }
    catch (error) { listening = false; onError?.(error); return; }
    if (!listening) { onError?.(new Error("Microphone recorder did not become ready.")); return; }
    onReady?.({ startedAt });
    const sample = () => {
      if (current !== generation || !listening) return;
      const elapsed = now() - startedAt; const level = rms();
      if(elapsed<calibrationMs&&level<Math.max(0.065,noiseFloor*4)){noiseFloor=Math.min(0.03,noiseFloor*0.75+level*0.25);timer=schedule(sample,sampleIntervalMs);return;}
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
          endpointGraceMs = adaptiveEndpointSilence({ voicedMs, speechSpanMs: endpointStartedAt - speechStartedAt, resumedEndpoints, endpointSilenceMs, shortFragmentSilenceMs, longUtteranceSilenceMs, resumedSpeechBonusMs, maxEndpointSilenceMs });
          onEndpoint?.({ phase: "possible-end", at: endpointStartedAt, graceMs: endpointGraceMs, resumedEndpoints });
        }
      }
      if (heardSpeech && endpointStartedAt && now() - endpointStartedAt >= endpointGraceMs) { stopRecorder(); return; }
      if (!heardSpeech && elapsed >= noSpeechMs) { stopRecorder(); return; }
      if (elapsed >= maxDurationMs) { stopRecorder(); return; }
      timer = schedule(sample, sampleIntervalMs);
    };
    timer = schedule(sample, sampleIntervalMs);
  }

  function watchForBargeIn(onBargeIn) {
    clearTimer(); const current = ++generation; let acousticFrames = 0; let speechFrames = 0; let baseline = 0.008;
    const sample = () => {
      if (current !== generation) return;
      const level=rms(); baseline=Math.min(0.035,baseline*0.96+level*0.04);
      const acoustic=level>=Math.max(bargeThreshold,baseline*2.4);
      acousticFrames=acoustic?acousticFrames+1:Math.max(0,acousticFrames-2);
      if(acousticFrames>=bargeAcousticFrames) speechFrames=acoustic?speechFrames+1:Math.max(0,speechFrames-1);
      if (speechFrames >= bargeSpeechFrames) { clearTimer(); onBargeIn?.({ confirmed:true, voicedMs:speechFrames*sampleIntervalMs }); return; }
      timer = schedule(sample, sampleIntervalMs);
    };
    timer = schedule(sample, sampleIntervalMs);
  }

  function stop() { generation += 1; clearTimer(); stopRecorder(); }
  async function destroy() { stop(); source?.disconnect?.(); for (const track of stream?.getTracks?.() || []) track.stop(); if (context && context.state !== "closed") await context.close(); stream = context = analyser = source = undefined; }
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
  let player; let objectUrl; let generation = 0; let iterator; let settlePlayback; let paused=false;
  const clearPlayer = () => { if (player) { player.pause(); player.removeAttribute?.("src"); player.load?.(); } if (objectUrl) URL.revokeObjectURL(objectUrl); player = objectUrl = undefined; };
  const stop = () => { generation += 1; paused=false; settlePlayback?.(); settlePlayback = undefined; clearPlayer(); Promise.resolve(iterator?.return?.()).catch(() => {}); iterator = undefined; };
  return Object.freeze({
    play(source, { onStarted, onEnded, onError, onChunkStarted } = {}) {
      stop(); const current = generation; iterator = toAudioStream(source)[Symbol.asyncIterator](); let chunkIndex=0;
      let started = false;
      const run = async () => {
        let item = await iterator.next();
        while (!item.done && current === generation) {
          const next = iterator.next().then((value) => ({ value }), (error) => ({ error }));
          await playBlob(item.value, current, () => {
            onChunkStarted?.({index:chunkIndex++});
            if (!started) { started = true; onStarted?.(); }
          });
          if (current !== generation) return;
          const prefetched = await next; if (prefetched.error) throw prefetched.error; item = prefetched.value;
        }
        if (current === generation) { clearPlayer(); iterator = undefined; onEnded?.(); }
      };
      run().catch((error) => { if (current === generation && error?.name !== "AbortError") { stop(); onError?.(error); } });
    },
    pause(){if(!player||paused)return false;paused=true;player.pause();return true;},
    resume({onStarted}={}){if(!player||!paused)return false;paused=false;Promise.resolve(player.play()).then(()=>onStarted?.()).catch(()=>{});return true;},
    checkpoint(){return player?{currentTime:Number(player.currentTime||0),paused}:null;},
    stop
  });

  function playBlob(blob, current, onStarted) {
    return new Promise((resolve, reject) => {
      clearPlayer(); objectUrl = URL.createObjectURL(blob); player = new Audio(objectUrl); player.preload = "auto";
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
