import {preferredRecorderOptions, novaMicrophoneConstraints} from './voice-capture.js';
import {createDiagnosticVault, encodeMonoWav} from './speaker-diagnostic-vault.js';

const $ = id => document.getElementById(id);
let grant, stream, recorder, context, interval, recordingTimeout, requestController, chunks = [], generation = 0;
let durationSeconds = 0, mimeType = '', reports = [], qualityAccepted = false, busy = false, originalHash = '', captureMetadata = {};
const status = message => { $('status').textContent = message; };
function stopHardware() {
  clearInterval(interval); clearTimeout(recordingTimeout);
  try { if (recorder?.state === 'recording') recorder.stop(); } catch {}
  stream?.getTracks().forEach(t => t.stop()); stream = recorder = undefined;
  void context?.close().catch(()=>{}); context = undefined; $('level').value = 0;
}
function deleted(reason) {
  if (reason === 'replaced') return;
  generation++; stopHardware(); requestController?.abort(); chunks = []; grant = undefined; busy = false;
  $('record').disabled = $('compare').disabled = $('cancel').disabled = true;
  $('prepare').disabled = !$('consent').checked;
  $('deadline').textContent = 'No recording retained. Temporary key and ciphertext discarded.';
  status(reason === 'expired' ? 'Diagnostic expired and was discarded. No further replay is possible.' : 'Recording and temporary key discarded. No enrollment was changed.');
}
const vault = createDiagnosticVault({onDelete:deleted});
function erase() { vault.erase('deleted'); }
window.addEventListener('pagehide', erase);
document.addEventListener('visibilitychange', () => { vault.available(); });
window.addEventListener('focus', () => { vault.available(); void checkSession(); });

async function checkSession() {
  try {
    const response = await fetch('/api/preview/session', {credentials:'same-origin',cache:'no-store'});
    if (!response.ok) { erase(); $('prepare').disabled=true; status('Sign into the original Nova first, then return to this page. No recording is available.'); return false; }
    return true;
  } catch { if (vault.available()) erase(); $('prepare').disabled=true; status('Owner session could not be checked. No recording can be processed.'); return false; }
}
async function post(path, data) {
  requestController = new AbortController();
  const response = await fetch('/api/voice/speaker/diagnostic/'+path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:requestController.signal});
  const result = await response.json();
  if (response.status === 401 || response.status === 403) { erase(); throw Error('Owner session or diagnostic permission expired. Recording discarded.'); }
  if (!response.ok) throw Error(result.code || 'Diagnostic service unavailable');
  return result;
}
function render() {
  $('results').replaceChildren();
  if (!reports.length) return;
  const table = document.createElement('table');
  const heading = document.createElement('tr');
  for (const text of ['Variant','Decoded / speech','VAD / full score','Decision']) { const th=document.createElement('th');th.textContent=text;heading.append(th); } table.append(heading);
  for (const r of reports) { const row=document.createElement('tr');for(const text of [r.variant,`${r.quality.totalDurationSeconds ?? '?'} / ${r.quality.speechSeconds ?? '?'} s`,`${r.match?.vadScore?.toFixed(3)??'—'} / ${r.match?.legacyScore?.toFixed(3)??'—'}`,r.match?.state||r.quality.reason||'quality rejected']) {const td=document.createElement('td');td.textContent=text;row.append(td);}table.append(row); }
  $('results').append(table);
  $('details').textContent=JSON.stringify({profiles:grant?.profiles,recording:{durationSeconds,mimeType,...captureMetadata},comparisons:reports},null,2);
}
const base64 = bytes => {let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);};
async function compareBytes(bytes, variant, duration, mime) {
  if (!grant || Date.now() >= grant.expiresAt || !vault.available()) throw Error('Diagnostic recording expired');
  const current=generation;
  const result=await post('compare',{token:grant.token,consent:true,variant,audioBase64:base64(bytes),mimeType:mime,durationSeconds:duration});
  if(current!==generation||!vault.available())throw Error('Diagnostic discarded');
  if(variant==='original')originalHash=result.sha256;
  if(variant==='original-repeat'&&result.sha256!==originalHash)throw Error('Original-byte identity check failed');
  reports.push(result);render();return result;
}
async function runComparisons() {
  if (busy || !vault.available() || !await checkSession()) return;
  busy=true;$('compare').disabled=true;const current=generation;
  let bytes, decoded, decoder, channels=[];
  try {
    bytes=await vault.read();
    if(!qualityAccepted){status('Rechecking the retained original without recording again…');qualityAccepted=(await compareBytes(bytes,'original',durationSeconds,mimeType)).usableDiagnostic;if(!qualityAccepted){status('Retained sample still does not pass the diagnostic quality gate. Do not record again yet; report the measurements.');return;}}
    status('Comparing the identical retained recording again…');
    await compareBytes(bytes,'original-repeat',durationSeconds,mimeType);
    // Web Audio explicitly decodes/resamples a copy. The original ciphertext is untouched.
    decoder=new (window.AudioContext||window.webkitAudioContext)({sampleRate:16000});
    decoded=await decoder.decodeAudioData(bytes.buffer.slice(0));bytes.fill(0);bytes=undefined;
    channels=Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i));
    const middle=Math.floor(decoded.length/2);
    for(const [variant,start,end] of [['decoded-full',0,decoded.length],['first-half',0,middle],['second-half',middle,decoded.length]]){
      if(current!==generation||!vault.available())throw Error('Diagnostic discarded');
      status(`Comparing ${variant} from the same recording…`);
      const wav=encodeMonoWav(channels,decoded.sampleRate,start,end);
      try{await compareBytes(wav,variant,(end-start)/decoded.sampleRate,'audio/wav');}finally{wav.fill(0);}
    }
    status('Comparisons complete. A match here grants no private access. Leave this tab open and reply “recorded” in Codex so the measurements can be reviewed.');
  } catch(error) {if(current===generation)status(`Comparison stopped: ${error.message}. The retained original stays available until its deadline unless deleted.`);}
  finally {bytes?.fill(0);for(const channel of channels)channel.fill(0);await decoder?.close().catch(()=>{});decoded=undefined;if(current===generation){busy=false;$('compare').disabled=!vault.available();}}
}
$('consent').addEventListener('change',async()=>{$('prepare').disabled=!$('consent').checked||!await checkSession();if(!$('consent').checked)erase();});
$('prepare').addEventListener('click',async event=>{
  if(!event.isTrusted||!$('consent').checked||!await checkSession())return;
  erase();const current=generation;$('prepare').disabled=true;status('Checking the existing speaker service and preparing the selected Nova microphone…');
  try{
    const next=await post('prepare',{consent:true});if(current!==generation)return;grant=next;
    $('deadline').textContent=`Automatic expiry: ${new Date(grant.expiresAt).toLocaleString()} (${new Date(grant.expiresAt).toISOString()}). Recording is not started.`;
    const acquired=await navigator.mediaDevices.getUserMedia({audio:novaMicrophoneConstraints(localStorage),video:false});
    if(current!==generation){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;
    const track=stream.getAudioTracks()[0],settings=track.getSettings();
    captureMetadata={microphoneLabel:track.label||'System default',settings:Object.fromEntries(['sampleRate','channelCount','echoCancellation','noiseSuppression','autoGainControl'].filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]]))};
    $('microphone').textContent=`Selected microphone: ${track.label||'System default'} · ${settings.sampleRate||'?'} Hz · ${settings.channelCount||'?'} channel(s) · echo cancellation ${settings.echoCancellation} · noise suppression ${settings.noiseSuppression} · automatic gain ${settings.autoGainControl}`;
    context=new(window.AudioContext||window.webkitAudioContext)();await context.resume();const source=context.createMediaStreamSource(stream),meter=context.createAnalyser();meter.fftSize=1024;source.connect(meter);const levels=new Float32Array(meter.fftSize);
    interval=setInterval(()=>{meter.getFloatTimeDomainData(levels);$('level').value=Math.min(1,Math.sqrt(levels.reduce((s,v)=>s+v*v,0)/levels.length)*8);if(grant&&Date.now()>=grant.expiresAt)erase();},100);
    $('record').disabled=false;$('cancel').disabled=false;reports=[];qualityAccepted=false;render();
    $('details').textContent=JSON.stringify({profiles:grant.profiles},null,2);
    status('Ready. Microphone is open for the level meter only. Check its name, then press Record 24 seconds.');
  }catch(error){if(current===generation){stopHardware();status(`Preparation stopped: ${error.message}. No recording retained.`);$('prepare').disabled=false;}}
});
$('record').addEventListener('click',event=>{
  if(!event.isTrusted||!stream||!grant||Date.now()>=grant.expiresAt)return;
  const current=generation;const active=new MediaRecorder(stream,preferredRecorderOptions(MediaRecorder));recorder=active;chunks=[];const started=performance.now();
  $('record').disabled=true;status('Recording now. Read naturally for 24 seconds; recording stops automatically.');
  active.addEventListener('dataavailable',event=>{if(current===generation&&event.data.size)chunks.push(event.data);});
  active.addEventListener('error',()=>{erase();status('Microphone recording failed; nothing retained.');});
  active.addEventListener('stop',async()=>{
    if(current!==generation)return;
    durationSeconds=(performance.now()-started)/1000;mimeType=active.mimeType||'audio/webm';
    captureMetadata={...captureMetadata,chunkCount:chunks.length,audioBitsPerSecond:active.audioBitsPerSecond||null};
    let blob=new Blob(chunks,{type:mimeType});chunks=[];stopHardware();let bytes;
    try{
      bytes=new Uint8Array(await blob.arrayBuffer());blob=undefined;
      if(current!==generation)return;
      await vault.retain(bytes,grant.expiresAt);
      if(current!==generation){vault.erase();return;}
      status('Recording encrypted in this tab. Checking decoded duration, speech quality and the original score…');
      const result=await compareBytes(bytes,'original',durationSeconds,mimeType);qualityAccepted=result.usableDiagnostic;
      bytes.fill(0);bytes=undefined;
      $('compare').disabled=false;
      if(qualityAccepted){status('Recording quality accepted for diagnosis. Comparing the same retained audio…');await runComparisons();}
      else status('Quality gate did not accept this as a complete diagnostic. The sample is retained for inspection even if it did not match. Leave the tab open and report this result; do not repeat yet.');
    }catch(error){if(current===generation)status(`Diagnostic stopped: ${error.message}. A retained sample, if present, expires at the displayed deadline. Do not repeat yet.`);}
    finally{bytes?.fill(0);if(current===generation)$('compare').disabled=!vault.available();}
  },{once:true});
  active.start(100);recordingTimeout=setTimeout(()=>{if(active.state==='recording')active.stop();},24000);
});
$('cancel').addEventListener('click',erase);
$('compare').addEventListener('click',()=>void runComparisons());
if(await checkSession())status('Owner account verified. Review retention, check consent, then prepare the microphone.');
// Re-check on return, and while open; no audio or measurements go to this check.
setInterval(()=>{vault.available();if(vault.available())void checkSession();},15000);
