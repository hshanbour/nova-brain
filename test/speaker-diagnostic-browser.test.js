import test from 'node:test';
import assert from 'node:assert/strict';

test('synthetic browser lifecycle retains one non-match, runs five comparisons, stops mic and deletes on page exit',async()=>{
 const saved=new Map();const install=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 const elements=new Map(),windowHandlers={},timers=new Map();let nextTimer=0,clock=0,recorders=0,stops=0,stopPromise,active;
 const element=id=>{if(!elements.has(id))elements.set(id,{id,disabled:true,checked:false,textContent:'',children:[],handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},replaceChildren(){this.children=[];},append(child){this.children.push(child);}});return elements.get(id);};
 const requests=[];let micOpened=0;
 const track={label:'Synthetic microphone fixture',getSettings:()=>({sampleRate:48000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}),stop:()=>stops++};
 class Recorder{static isTypeSupported(){return true;}constructor(stream,options){recorders++;assert.equal(options.audioBitsPerSecond,64000);this.state='inactive';this.mimeType='audio/webm;codecs=opus';this.audioBitsPerSecond=64000;this.handlers={};active=this;}addEventListener(name,fn){this.handlers[name]=fn;}start(timeslice){assert.equal(timeslice,100);this.state='recording';}stop(){this.state='inactive';this.handlers.dataavailable({data:new Blob(['synthetic recording only'])});stopPromise=this.handlers.stop();}}
 class Context{constructor(){this.state='running';}resume(){return Promise.resolve();}close(){return Promise.resolve();}createMediaStreamSource(){return{connect(){}};}createAnalyser(){return{fftSize:1024,getFloatTimeDomainData(){}};}async decodeAudioData(){const channel=new Float32Array(384000).fill(.1);return{numberOfChannels:1,length:channel.length,sampleRate:16000,getChannelData:()=>channel};}}
 try{
  install('document',{getElementById:element,createElement:tag=>({tag,children:[],append(child){this.children.push(child);}}),addEventListener(){}});
  install('window',{addEventListener:(name,fn)=>windowHandlers[name]=fn,AudioContext:Context});
  install('navigator',{mediaDevices:{getUserMedia:async({audio})=>{micOpened++;assert.equal(audio.deviceId.exact,'selected');return{getAudioTracks:()=>[track],getTracks:()=>[track]};}}});
  install('localStorage',{getItem:key=>{assert.equal(key,'nova-microphone-device-id');return'selected';}});
  install('MediaRecorder',Recorder);install('performance',{now:()=>clock});
  install('setInterval',()=>++nextTimer);install('clearInterval',()=>{});
  install('setTimeout',(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;});install('clearTimeout',id=>timers.delete(id));
  install('fetch',async(path,options)=>{
   if(path==='/api/preview/session')return Response.json({workspaceId:'owner'});
   const data=JSON.parse(options.body);requests.push({path,data});
   if(path.endsWith('/prepare'))return Response.json({token:'diagnostic-only-fixture',expiresAt:Date.now()+30*60*1000,profiles:{readableOwnerProfiles:1}});
   assert.ok(path.endsWith('/compare'));assert.equal(data.token,'diagnostic-only-fixture');
   return Response.json({variant:data.variant,sha256:data.variant.startsWith('original')?'same-bytes':data.variant,quality:{totalDurationSeconds:data.durationSeconds,speechSeconds:16},match:{state:'unknown',vadScore:.1,legacyScore:.293},usableDiagnostic:true,privateAccessGranted:false});
  });
  await import('../assets/speaker-diagnostic.js?synthetic-browser-test');
  assert.equal(micOpened,0);assert.equal(requests.length,0);
  element('consent').checked=true;await element('consent').handlers.change();await element('prepare').handlers.click({isTrusted:true});
  assert.equal(micOpened,1);assert.equal(recorders,0);assert.match(element('microphone').textContent,/Synthetic microphone/);assert.match(element('deadline').textContent,/Automatic expiry/);
  element('record').handlers.click({isTrusted:true});clock=24000;
  const timer=[...timers.values()].find(t=>t.delay===24000);assert.ok(timer);timer.fn();await stopPromise;
  assert.equal(recorders,1);assert.equal(stops,1);
  assert.deepEqual(requests.filter(r=>r.path.endsWith('/compare')).map(r=>r.data.variant),['original','original-repeat','decoded-full','first-half','second-half']);
  assert.match(element('status').textContent,/Comparisons complete/);assert.equal(element('compare').disabled,false);
  assert.doesNotMatch(element('details').textContent,/diagnostic-only-fixture|audioBase64/);
  windowHandlers.pagehide();assert.equal(element('compare').disabled,true);assert.match(element('deadline').textContent,/discarded/);
 }finally{for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
