export function createMediaVoiceCapture({
  mediaDevices, MediaRecorder, AudioContext,
  schedule = (callback, delay) => setTimeout(callback, delay), cancelSchedule = (timer) => clearTimeout(timer),
  now = () => Date.now(), sampleIntervalMs = 50, silenceMs = 700, noSpeechMs = 8_000, maxDurationMs = 30_000,
  speechThreshold = 0.035, bargeThreshold = 0.065, recorderTimesliceMs = 100, bargeFrames = 2
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

  function listen({ onReady, onAudio, onNoSpeech, onError }) {
    clearTimer(); stopRecorder(); const current = ++generation;
    const chunks = [];
    let speechFrames = 0; let heardSpeech = false; let silenceStarted = 0; let noiseFloor = 0.008; const startedAt = now();
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
      onAudio?.({ audio: new Blob(chunks, { type: activeRecorder.mimeType || "audio/webm" }), mimeType: activeRecorder.mimeType || "audio/webm", durationSeconds, endedAt });
    });
    try { activeRecorder.start(recorderTimesliceMs); listening = activeRecorder.state === "recording"; }
    catch (error) { listening = false; onError?.(error); return; }
    if (!listening) { onError?.(new Error("Microphone recorder did not become ready.")); return; }
    onReady?.({ startedAt });
    const sample = () => {
      if (current !== generation || !listening) return;
      const elapsed = now() - startedAt; const level = rms();
      if (!heardSpeech) noiseFloor = Math.min(0.03, noiseFloor * 0.92 + level * 0.08);
      if (level >= Math.max(speechThreshold, noiseFloor * 3)) { speechFrames += 1; if (speechFrames >= 2) { heardSpeech = true; silenceStarted = 0; } }
      else { speechFrames = 0; if (heardSpeech && !silenceStarted) silenceStarted = now(); }
      if (heardSpeech && silenceStarted && now() - silenceStarted >= silenceMs) { stopRecorder(); return; }
      if (!heardSpeech && elapsed >= noSpeechMs) { stopRecorder(); return; }
      if (elapsed >= maxDurationMs) { stopRecorder(); return; }
      timer = schedule(sample, sampleIntervalMs);
    };
    timer = schedule(sample, sampleIntervalMs);
  }

  function watchForBargeIn(onBargeIn) {
    clearTimer(); const current = ++generation; let frames = 0;
    const sample = () => {
      if (current !== generation) return;
      if (rms() >= bargeThreshold) frames += 1; else frames = 0;
      if (frames >= bargeFrames) { clearTimer(); onBargeIn?.(); return; }
      timer = schedule(sample, sampleIntervalMs);
    };
    timer = schedule(sample, sampleIntervalMs);
  }

  function stop() { generation += 1; clearTimer(); stopRecorder(); }
  async function destroy() { stop(); source?.disconnect?.(); for (const track of stream?.getTracks?.() || []) track.stop(); if (context && context.state !== "closed") await context.close(); stream = context = analyser = source = undefined; }
  return Object.freeze({ supported, connect, listen, watchForBargeIn, stop, destroy });
}

function preferredRecorderOptions(MediaRecorder) {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) if (MediaRecorder.isTypeSupported?.(mimeType)) return { mimeType, audioBitsPerSecond: 64_000 };
  return { audioBitsPerSecond: 64_000 };
}

export function createAudioPlayback({ Audio, URL }) {
  let player; let objectUrl;
  const stop = () => { if (player) { player.pause(); player.removeAttribute?.("src"); player.load?.(); } if (objectUrl) URL.revokeObjectURL(objectUrl); player = objectUrl = undefined; };
  return Object.freeze({
    play(blob, { onStarted, onEnded, onError } = {}) {
      stop(); objectUrl = URL.createObjectURL(blob); player = new Audio(objectUrl); player.preload = "auto";
      let started = false; const reportStarted = () => { if (started) return; started = true; onStarted?.(); };
      player.addEventListener("playing", reportStarted, { once: true });
      player.addEventListener("ended", () => { stop(); onEnded?.(); }, { once: true });
      player.addEventListener("error", () => { stop(); onError?.(); }, { once: true });
      Promise.resolve(player.play()).then(reportStarted).catch(() => { stop(); onError?.(); });
    },
    stop
  });
}
