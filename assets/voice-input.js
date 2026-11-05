export const MICROPHONE_LANGUAGES = Object.freeze([
  { code: 'en-US', label: 'English' },
  { code: 'ar-SA', label: 'العربية' },
  { code: 'ar-EG', label: 'العربية (مصر)' }
]);

const languages = new Set(MICROPHONE_LANGUAGES.map(({ code }) => code));
const states = new Set(['idle', 'connecting', 'recording', 'processing', 'complete', 'error']);
const root = typeof window === 'undefined' ? {} : window;
const WAVEFORM_BAR_COUNT = 64;

const base = (dependencies = {}) => ({
  SpeechRecognition: root.SpeechRecognition || root.webkitSpeechRecognition,
  storage: root.localStorage,
  mediaDevices: root.navigator?.mediaDevices,
  MediaRecorder: root.MediaRecorder,
  AudioContext: root.AudioContext || root.webkitAudioContext,
  schedule: root.setTimeout?.bind(root) || setTimeout,
  cancelSchedule: root.clearTimeout?.bind(root) || clearTimeout,
  requestAnimationFrame: root.requestAnimationFrame?.bind(root) || ((callback) => setTimeout(callback, 16)),
  cancelAnimationFrame: root.cancelAnimationFrame?.bind(root) || clearTimeout,
  ...dependencies
});

const metadata = (text) => ({
  text,
  direction: /[\u0600-\u06ff]/.test(text) ? 'rtl' : 'ltr'
});

export function createVoiceInput(options = {}) {
  const dependencies = base(options.dependencies);
  const Recognition = dependencies.SpeechRecognition;
  const callbacks = {
    onState: options.onState || (() => {}),
    onText: options.onText || (() => {}),
    onError: options.onError || (() => {}),
    onAmplitude: options.onAmplitude || (() => {}),
    onSpectrum: options.onSpectrum || (() => {})
  };

  let language = options.language || dependencies.storage?.getItem?.('nova-composer-language') || 'en-US';
  let state = 'idle';
  let recognition;
  let token = 0;
  let draft = '';
  let finalText = '';
  let stream;
  let context;
  let source;
  let analyser;
  let frame;
  let stopped = false;

  if (!languages.has(language)) language = 'en-US';

  const setState = (next) => {
    if (!states.has(next)) return;
    state = next;
    callbacks.onState(next);
  };

  const publishAmplitude = (value) => {
    callbacks.onAmplitude(Math.max(0, Math.min(1, value || 0)));
  };

  const publishSpectrum = (levels = []) => {
    callbacks.onSpectrum(levels.map((value) => Math.max(0, Math.min(1, value || 0))));
  };

  const clearMeter = () => {
    if (frame) dependencies.cancelAnimationFrame(frame);
    frame = undefined;
    source?.disconnect?.();
    analyser?.disconnect?.();
    stream?.getTracks?.().forEach((track) => track.stop());
    context?.close?.();
    stream = undefined;
    context = undefined;
    source = undefined;
    analyser = undefined;
    publishAmplitude(0);
    publishSpectrum([]);
  };

  const finish = (next) => {
    clearMeter();
    setState(next);
  };

  const fail = (id, event = {}) => {
    if (id !== token) return;
    callbacks.onText(draft, metadata(draft), false);
    callbacks.onError({
      code: event.error || 'recognition-error',
      message: event.message || 'Microphone transcription failed. Your draft was restored.',
      recoverable: true
    });
    finish('error');
  };

  const meter = async (id) => {
    if (!dependencies.mediaDevices?.getUserMedia || !dependencies.AudioContext) return;

    try {
      stream = await dependencies.mediaDevices.getUserMedia({ audio: true });
      if (id !== token || state !== 'recording') {
        clearMeter();
        return;
      }

      context = new dependencies.AudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .72;
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      const frequencies = new Uint8Array(analyser.frequencyBinCount);
      const smoothedBars = Array.from({ length: WAVEFORM_BAR_COUNT }, () => 0);
      let smooth = 0;
      const tick = () => {
        if (id !== token || state !== 'recording') return;
        analyser.getByteTimeDomainData(samples);
        analyser.getByteFrequencyData(frequencies);

        let sum = 0;
        for (const value of samples) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }

        const raw = Math.sqrt(sum / samples.length);
        const target = raw < .012 ? 0 : Math.min(1, raw * 8);
        smooth += (target - smooth) * (target > smooth ? .42 : .16);
        publishAmplitude(smooth < .008 ? 0 : smooth);

        const levels = smoothedBars.map((previous, index) => {
          const start = Math.floor((index / WAVEFORM_BAR_COUNT) * frequencies.length);
          const end = Math.max(start + 1, Math.floor(((index + 1) / WAVEFORM_BAR_COUNT) * frequencies.length));
          let peak = 0;
          for (let bin = start; bin < end; bin += 1) peak = Math.max(peak, frequencies[bin] || 0);
          const measured = peak / 255;
          const next = previous + (measured - previous) * (measured > previous ? .46 : .18);
          smoothedBars[index] = next < .012 ? 0 : next;
          return smoothedBars[index];
        });
        publishSpectrum(levels);
        frame = dependencies.requestAnimationFrame(tick);
      };

      tick();
    } catch {
      publishAmplitude(0);
      publishSpectrum([]);
    }
  };

  const start = (value = '') => {
    if (!Recognition || state === 'recording' || state === 'processing') return false;

    clearMeter();
    draft = value;
    finalText = '';
    stopped = false;
    const id = ++token;
    recognition = new Recognition();
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (id !== token) return;

      let interim = '';
      let finalChunk = '';
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0].transcript;
        if (result.isFinal) finalChunk += text;
        else interim += text;
      }

      if (finalChunk) finalText += finalChunk;
      const text = `${draft}${finalText}${interim}`;
      callbacks.onText(text, metadata(text), Boolean(interim));
    };
    recognition.onerror = (event) => fail(id, event);
    recognition.onend = () => {
      if (id !== token) return;
      if (state === 'recording' || (state === 'processing' && stopped)) finish('complete');
    };

    setState('recording');
    publishAmplitude(0);
    publishSpectrum([]);
    meter(id);

    try {
      recognition.start();
      return true;
    } catch (error) {
      fail(id, error);
      return false;
    }
  };

  return {
    supported: Boolean(Recognition),
    start,
    commit() {
      if (state !== 'recording' && state !== 'processing') return false;
      const activeRecognition = recognition;
      token += 1;
      recognition = undefined;
      stopped = false;
      draft = '';
      finalText = '';
      clearMeter();
      if (activeRecognition?.abort) activeRecognition.abort();
      else activeRecognition?.stop?.();
      setState('complete');
      return true;
    },
    stop() {
      if (state !== 'recording') return false;
      stopped = true;
      setState('processing');
      clearMeter();
      recognition?.stop?.();
      if (!recognition?.stop) finish('complete');
      return true;
    },
    getState: () => state,
    getLanguage: () => language,
    setLanguage(next) {
      if (!languages.has(next)) throw new Error('Unsupported microphone language');
      language = next;
      dependencies.storage?.setItem?.('nova-composer-language', next);

      if (recognition) {
        token += 1;
        recognition.abort?.();
        recognition = undefined;
        clearMeter();
        if (state === 'recording' || state === 'processing') setState('idle');
      }
    },
    destroy() {
      token += 1;
      clearMeter();
      recognition?.abort?.();
    }
  };
}

export function createServerVoiceInput(options = {}) {
  const dependencies=base(options.dependencies),callbacks={onState:options.onState||(()=>{}),onText:options.onText||(()=>{}),onError:options.onError||(()=>{}),onAmplitude:options.onAmplitude||(()=>{}),onSpectrum:options.onSpectrum||(()=>{})};
  let state='idle',draft='',stream,recorder,chunks=[],startedAt=0,token=0,accessTimer,maxTimer,context,source,analyser,frame;
  const supported=Boolean(dependencies.mediaDevices?.getUserMedia&&dependencies.MediaRecorder&&typeof options.transcribe==='function');
  const setState=next=>{if(states.has(next)){state=next;callbacks.onState(next);}};
  const clean=()=>{if(accessTimer!==undefined)dependencies.cancelSchedule(accessTimer);if(maxTimer!==undefined)dependencies.cancelSchedule(maxTimer);if(frame!==undefined)dependencies.cancelAnimationFrame(frame);accessTimer=maxTimer=frame=undefined;source?.disconnect?.();analyser?.disconnect?.();context?.close?.();for(const track of stream?.getTracks?.()||[])track.stop();stream=context=source=analyser=undefined;callbacks.onAmplitude(0);callbacks.onSpectrum([]);};
  const startMeter=id=>{if(!dependencies.AudioContext)return;context=new dependencies.AudioContext();source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.62;source.connect(analyser);const samples=new Uint8Array(analyser.fftSize),frequencies=new Uint8Array(analyser.frequencyBinCount),smoothed=Array.from({length:WAVEFORM_BAR_COUNT},()=>0);const tick=()=>{if(id!==token||state!=="recording")return;analyser.getByteTimeDomainData(samples);analyser.getByteFrequencyData(frequencies);let sum=0;for(const value of samples){const normalized=(value-128)/128;sum+=normalized*normalized;}const rms=Math.sqrt(sum/samples.length),amplitude=rms<.004?0:Math.min(1,rms*8);callbacks.onAmplitude(amplitude);callbacks.onSpectrum(smoothed.map((previous,index)=>{const start=Math.floor(index/WAVEFORM_BAR_COUNT*frequencies.length),end=Math.max(start+1,Math.floor((index+1)/WAVEFORM_BAR_COUNT*frequencies.length));let peak=0;for(let bin=start;bin<end;bin+=1)peak=Math.max(peak,frequencies[bin]||0);const measured=peak/255,next=previous+(measured-previous)*(measured>previous ? .46 : .18);smoothed[index]=next<.012?0:next;return smoothed[index];}));frame=dependencies.requestAnimationFrame(tick);};void context.resume?.();tick();};
  const fail=(id,error)=>{if(id!==token)return;clean();callbacks.onText(draft,metadata(draft),false);callbacks.onError({code:error?.code||'transcription-error',message:error?.message||'Microphone transcription failed. Your draft was restored.',recoverable:true});setState('error');};
  const start=async(value='')=>{
    if(!supported||state==='connecting'||state==='recording'||state==='processing')return false;
    clean();draft=value;chunks=[];const id=++token;setState('connecting');
    try{
      const audioConstraints=typeof dependencies.getAudioConstraints==='function'?dependencies.getAudioConstraints():{echoCancellation:true,noiseSuppression:true,autoGainControl:true};
      const access=Promise.resolve(dependencies.mediaDevices.getUserMedia({audio:audioConstraints,video:false})).then(candidate=>{if(id!==token){for(const track of candidate?.getTracks?.()||[])track.stop();throw new Error('Microphone request was cancelled.');}return candidate;});
      stream=await Promise.race([access,new Promise((_,reject)=>{accessTimer=dependencies.schedule(()=>reject(new Error('Microphone access timed out. Allow microphone access in the browser, then try again.')),20_000);})]);
      if(accessTimer!==undefined)dependencies.cancelSchedule(accessTimer);accessTimer=undefined;
      recorder=new dependencies.MediaRecorder(stream,preferredOptions(dependencies.MediaRecorder));
      recorder.addEventListener('dataavailable',event=>{if(id===token&&event.data?.size)chunks.push(event.data);});
      recorder.addEventListener('error',event=>fail(id,event.error||new Error('Microphone recording failed.')));
      recorder.addEventListener('stop',async()=>{
        if(id!==token)return;clean();setState('processing');
        try{
          if(!chunks.length)throw new Error('No speech audio was captured. Please try again.');
          const audio=new Blob(chunks,{type:recorder.mimeType||'audio/webm'}),result=await options.transcribe({audio,mimeType:audio.type,durationSeconds:Math.max(.1,(Date.now()-startedAt)/1000)});
          if(id!==token)return;const transcript=String(result?.transcript||result?.text||'').trim();if(!transcript)throw new Error('No speech was detected. Please try again.');
          const spacer=draft&&!/\s$/.test(draft)?' ':'';const text=`${draft}${spacer}${transcript}`;callbacks.onText(text,metadata(text),false);setState('complete');
        }catch(error){fail(id,error);}
      });
      startedAt=Date.now();recorder.start(250);setState('recording');startMeter(id);maxTimer=dependencies.schedule(()=>{if(id===token&&recorder?.state==='recording')recorder.stop();},30_000);return true;
    }catch(error){fail(id,error);return false;}
  };
  return{supported,start,stop(){if(state!=='recording')return false;setState('processing');if(recorder?.state==='recording')recorder.stop();else fail(token,new Error('Microphone recorder is unavailable.'));return true;},commit(){if(!['connecting','recording','processing'].includes(state))return false;token+=1;try{recorder?.stop?.();}catch{}clean();setState('complete');return true;},getState:()=>state,getLanguage:()=> 'auto',setLanguage(){},destroy(){token+=1;try{recorder?.stop?.();}catch{}clean();}};
}

function preferredOptions(MediaRecorder){
  for(const mimeType of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])if(MediaRecorder.isTypeSupported?.(mimeType))return{mimeType,audioBitsPerSecond:64_000};
  return{audioBitsPerSecond:64_000};
}

export function createComposerVoiceControl(options = {}) {
  const { input, button, reviewButton, sendNowButton, statusTarget, errorTarget, waveformTarget, resizeInput } = options;
  if (!input || !button) throw new Error('Composer voice control requires input and button');

  let controller;
  let lastError = '';
  let spectrum = [];
  let sendAfterTranscript = false;

  const ensureWaveformBars = () => {
    const documentRef = waveformTarget?.ownerDocument;
    if (!waveformTarget || !documentRef?.createElement) return [];
    const bars = Array.from({ length: WAVEFORM_BAR_COUNT }, () => documentRef.createElement('span'));
    waveformTarget.replaceChildren(...bars);
    return bars;
  };

  const bars = ensureWaveformBars();
  const renderBars = (state) => {
    if (!waveformTarget) return;
    const active = state === 'recording';
    const nodes = bars.length ? bars : [...(waveformTarget.children || [])];
    nodes.forEach((bar, index) => {
      const level = active ? spectrum[index] || 0 : 0;
      bar.style.height = `${active ? 5 + Math.round(level * 34) : 5}px`;
      bar.style.opacity = active ? `${.42 + level * .58}` : '.42';
    });
  };

  const render = (state, error = lastError, amplitude = 0) => {
    lastError = error || '';
    button.dataset.voiceState = state;
    button.setAttribute('aria-pressed', String(state === 'recording'));
    const buttonLabel = state === 'recording' ? 'Stop and review dictation' : state === 'processing' ? 'Processing dictation' : 'Dictate message';
    button.setAttribute('aria-label', buttonLabel);
    button.setAttribute('title', buttonLabel);
    button.disabled = !controller.supported || state === 'processing';
    if (reviewButton) { reviewButton.hidden = true; reviewButton.disabled = true; }
    if (sendNowButton) { sendNowButton.hidden = state !== 'recording'; sendNowButton.disabled = state !== 'recording'; }

    if (statusTarget) {
      statusTarget.textContent = !controller.supported
        ? 'Microphone is unavailable in this browser.'
        : ({
            idle: 'Microphone ready · Arabic + English auto-detect',
            connecting: 'Connecting microphone…',
            recording: 'Listening…',
            processing: 'Processing dictation…',
            complete: 'Dictation complete',
            error: 'Dictation failed'
          }[state]);
    }

    if (errorTarget) errorTarget.textContent = lastError.message || '';
    if (waveformTarget) {
      waveformTarget.dataset.voiceState = state;
      waveformTarget.style.setProperty('--composer-voice-amplitude', `${Math.round((amplitude || 0) * 12)}px`);
      renderBars(state);
    }
  };

  const controllerOptions={
    language: options.language,
    dependencies: options.dependencies,
    onState: (state) => {
      render(state, state === 'recording' ? '' : lastError);
      if (state === 'complete' && sendAfterTranscript) {
        sendAfterTranscript = false;
        queueMicrotask(() => options.onSendImmediately?.(input.value));
      }
    },
    onText: (text, info) => {
      input.value = text;
      input.dir = info.direction;
      resizeInput?.();
    },
    onError: (error) => render('error', error, 0),
    onAmplitude: (amplitude) => render(controller.getState(), lastError, amplitude),
    onSpectrum: (levels) => {
      spectrum = levels;
      render(controller.getState(), lastError);
    }
  };
  controller = typeof options.transcribe==='function'?createServerVoiceInput({...controllerOptions,transcribe:options.transcribe}):createVoiceInput(controllerOptions);

  const click = async () => {
    if (controller.getState() === 'recording') { sendAfterTranscript = false; controller.stop(); }
    else await controller.start(input.value);
  };
  const stopForReview = () => { sendAfterTranscript = false; return controller.stop(); };
  const stopAndSend = () => { if (controller.getState() !== 'recording') return false; sendAfterTranscript = true; return controller.stop(); };

  button.addEventListener('click', click);
  reviewButton?.addEventListener('click', stopForReview);
  sendNowButton?.addEventListener('click', stopAndSend);
  render('idle');

  return {
    controller,
    stopForReview,
    stopAndSend,
    commit: controller.commit,
    getState: controller.getState,
    getLanguage: controller.getLanguage,
    setLanguage: controller.setLanguage,
    destroy() {
      button.removeEventListener('click', click);
      reviewButton?.removeEventListener('click', stopForReview);
      sendNowButton?.removeEventListener('click', stopAndSend);
      controller.destroy();
    }
  };
}
