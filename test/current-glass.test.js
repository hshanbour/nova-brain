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
 for(const file of ['current-glass-avatar.js','current-glass-signal.js','current-glass/coreScene.js','current-glass/sceneEnvironment.js','current-glass/livingField.js','current-glass/visualDemo.js','current-glass/emeraldTide.js','current-glass/tideTiming.js','current-glass/voice-demo.wav','current-glass/nova.glb','current-glass/nova-display.glb']){
  const response={setHeader(){},end(){}};assert.equal(await serve({method:'GET',url:'/assets/'+file},response),true);assert.equal(response.statusCode,200);
 }
 assert.equal(loaded.length,11);
});

test('display mesh retains the original bounds and embedded artwork while reducing geometry',async()=>{
 const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const original=await readFile(new URL('../assets/current-glass/nova.glb',import.meta.url));
 const display=await readFile(new URL('../assets/current-glass/nova-display.glb',import.meta.url));
 const parse=b=>{const length=b.readUInt32LE(12);return {g:JSON.parse(b.subarray(20,20+length)),bin:b.subarray(28+length)};};
 const a=parse(original),b=parse(display);const ap=a.g.meshes[0].primitives[0],bp=b.g.meshes[0].primitives[0];
 assert.equal(createHash('sha256').update(original).digest('hex'),'641f6566d7138c68309902019bb460921f9f2fea23260fdd6e3d3f3c17a60500');
 assert.deepEqual(a.g.accessors[ap.attributes.POSITION].min,b.g.accessors[bp.attributes.POSITION].min);
 assert.deepEqual(a.g.accessors[ap.attributes.POSITION].max,b.g.accessors[bp.attributes.POSITION].max);
 assert.ok(b.g.accessors[bp.indices].count<=120000*3);
 assert.ok(display.length<original.length/3);
 for(let i=0;i<a.g.images.length;i++){const bytes=(data,image)=>{const view=data.g.bufferViews[image.bufferView];return data.bin.subarray(view.byteOffset,view.byteOffset+view.byteLength);};assert.deepEqual(bytes(a,a.g.images[i]),bytes(b,b.g.images[i]));}
});
