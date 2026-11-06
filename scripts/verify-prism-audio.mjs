import {chromium} from 'playwright-core';import {createServer} from 'node:http';import fs from 'node:fs';import {createStaticFileHandler} from '../src/http/static-files.js';
// Run with a local, non-sensitive speech WAV fixture. No provider, microphone or customer accounts are used.
const wav=process.argv[2];if(!wav||!fs.existsSync(wav))throw Error('Usage: node scripts/verify-prism-audio.mjs <speech.wav>');
const serve=createStaticFileHandler();const srv=createServer(async(q,r)=>{if(q.url==='/qa'){r.setHeader('Content-Type','text/html');r.end('<html><head><title>Local audio test</title></head><body></body></html>');return;}if(q.url==='/clip'){r.end(fs.readFileSync(wav));return;}if(!await serve(q,r))r.writeHead(404).end();});await new Promise(k=>srv.listen(0,'127.0.0.1',k));let br;
try{
 br=await chromium.launch({channel:'msedge',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader']});const page=await br.newPage();await page.goto('http://127.0.0.1:'+srv.address().port+'/qa');
 const result=await page.evaluate(async()=>{
 const {createRealtimeVoice}=await import('/assets/realtime-voice.js'),{createPrismBust}=await import('/assets/prism-bust.js');
 const remote=new RTCPeerConnection(),ac=new AudioContext(),audio=ac.createMediaStreamDestination(),clip=await ac.decodeAudioData(await(await fetch('/clip')).arrayBuffer());await ac.resume();remote.addTrack(audio.stream.getAudioTracks()[0],audio.stream);
 let chan,resolveOpen;const opened=new Promise(r=>resolveOpen=r);remote.ondatachannel=e=>{chan=e.channel;chan.onopen=resolveOpen;if(chan.readyState==='open')resolveOpen();};
 let shape={},level=0,state='',playing=0,maxOpen=0,nonZero=0,restCount=0,signals=0;
 document.body.replaceChildren();const cvs=document.createElement('canvas');document.body.append(cvs);cvs.style.width='380px';cvs.style.height='348px';
 const bust=createPrismBust({canvas:cvs,mouth:()=>shape,outputLevel:()=>level});bust.start();
 const v=createRealtimeVoice({onArticulation:s=>{shape=s;maxOpen=Math.max(maxOpen,s.open);if(s.open>.035)nonZero++;else if(s.open===0)restCount++;},onOutputLevel:v=>{level=v;},onState:e=>{state=e.state;bust.setState(state);if(e.phase==='playing')playing++;},onError:m=>{throw Error(m)},MediaRecorderImpl:null,fetchImpl:async (url,opts)=>{
 if(url==='/api/voice/speaker/readiness')return Response.json({});if(url==='/api/voice/realtime/session')return Response.json({clientSecret:'ek_local_test_only'});
 await remote.setRemoteDescription({type:'offer',sdp:opts.body});await remote.setLocalDescription(await remote.createAnswer());
 if(remote.iceGatheringState!=='complete')await new Promise(r=>remote.addEventListener('icegatheringstatechange',()=>{if(remote.iceGatheringState==='complete')r();}));
 return new Response(remote.localDescription.sdp);
 }});
 const wait=ms=>new Promise(r=>setTimeout(r,ms));await v.start();await Promise.race([opened,wait(12000).then(()=>{throw Error('Loopback channel not ready');})]);const send=o=>chan.send(JSON.stringify(o));
 const firstVisual=[];for(let i=0;i<12;i++){const id='t'+i;send({type:'input_audio_buffer.speech_started',item_id:id});send({type:'input_audio_buffer.speech_stopped',item_id:id});send({type:'response.created',response:{id}});const source=ac.createBufferSource();source.buffer=clip;source.connect(audio);source.start(0,.15,1.5);send({type:'output_audio_buffer.started'});const time=performance.now();let seen=false;for(let n=0;n<22;n++){await wait(65);if(!seen&&shape.open>.035){seen=true;firstVisual.push(Math.round(performance.now()-time));}}if(i%3===1){v.interrupt();signals++;}send({type:'output_audio_buffer.stopped'});send({type:'response.done',response:{id,output:[]}});await wait(90);}
 const stats={playbackStarts:playing,manualInterruptions:signals,turnsWithMeasuredMotion:firstVisual.length,firstMotionMs:firstVisual,nonzeroShapes:nonZero,peakOpen:maxOpen,silentSamples:restCount,fps:bust.metrics().fps,active:v.isActive()};
 v.end();bust.dispose();remote.close();audio.stream.getTracks().forEach(t=>t.stop());await ac.close();return stats;
 });console.log(result);if(result.playbackStarts!==12||result.turnsWithMeasuredMotion!==12||!result.active||result.manualInterruptions!==4)throw Error('Audio / articulation continuity failed');}finally{await br?.close();srv.closeAllConnections();srv.close();}
