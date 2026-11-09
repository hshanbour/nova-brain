import test from 'node:test';
import assert from 'node:assert/strict';
import {createGlassSignal} from '../assets/current-glass-signal.js';
import {createStaticFileHandler} from '../src/http/static-files.js';
test('glass follows only active realtime playback; interruption and next turn do not retain energy',()=>{
 const signal=createGlassSignal();signal.output(.9);assert.equal(signal.read().playback,0);
 signal.state({active:true,mode:'realtime',state:'listening'});signal.input(.3);assert.equal(signal.read().microphone,.3);
 signal.state({active:true,mode:'realtime',state:'speaking'});signal.output(.7);assert.equal(signal.read().playback,.7);
 signal.state({active:true,mode:'realtime',state:'listening'});signal.output(0);assert.equal(signal.read().playback,0);
 signal.state({active:true,mode:'realtime',state:'thinking'});assert.equal(signal.read().phase,'preparing');
 signal.state({active:true,mode:'realtime',state:'speaking'});assert.equal(signal.read().playback,0);signal.output(.4);assert.equal(signal.read().playback,.4);
 signal.state({active:true,mode:'realtime',state:'muted'});signal.output(.4);assert.equal(signal.read().playback,.4);assert.equal(signal.read().microphone,0);
 signal.reset();assert.equal(signal.read().playback,0);assert.equal(signal.read().speaking,false);
 signal.state({active:true,mode:'batch',state:'speaking'});signal.output(.9);assert.equal(signal.read().playback,0);
});
test('glass static modules and unchanged model have explicit local routes',async()=>{
 const loaded=[];const serve=createStaticFileHandler({loadFile:async p=>{loaded.push(String(p));return Buffer.from('asset');}});
 for(const file of ['current-glass-avatar.js','current-glass-signal.js','current-glass/coreScene.js','current-glass/nova.glb']){
  const response={setHeader(){},end(){}};assert.equal(await serve({method:'GET',url:'/assets/'+file},response),true);assert.equal(response.statusCode,200);
 }
 assert.equal(loaded.length,4);
});
