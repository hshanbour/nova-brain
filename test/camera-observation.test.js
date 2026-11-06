import test from 'node:test';
import assert from 'node:assert/strict';
import {interpret,currentScene} from '../assets/vision/observation.js';
test('pointing only identifies an unambiguous target, never a person or permission',()=>{
 const points=Array.from({length:21},()=>({x:.2,y:.55}));points[0]={x:.1,y:.55};points[6]={x:.2,y:.55};points[8]={x:.4,y:.55};
 const b=(name,x)=>({name,x,y:.55,w:.2,h:.2});
 const a=interpret({time:10,points,boxes:[b('person',.6),b('cup',.75)]});
 assert.equal(a.possiblePointingTarget,'cup');assert.equal(a.personPosition,.6);
 assert.equal(interpret({time:10,points,boxes:[b('cup',.75),b('phone',.8)]}).possiblePointingTarget,null);
 assert.deepEqual(currentScene(a,2511),{observed:false});
 assert.ok(!Object.hasOwn(currentScene(a,15),'points'));assert.deepEqual(currentScene(null,15),{observed:false});
});
