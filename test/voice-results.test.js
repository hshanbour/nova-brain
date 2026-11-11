import test from 'node:test';
import assert from 'node:assert/strict';
import {projectVoiceResult,createVoiceResults} from '../assets/voice-results.js';

const result={conversationId:'owner-thread',runId:'receipt-1',runStatus:'completed',message:'A supported finding.',toolCalls:[{name:'project_understanding',status:'completed',arguments:{token:'never display'},result:{privatePayload:'never display',sources:[{id:'source-1',label:'Project README',locator:'https://example.com/readme',retrievedAt:'2026-11-11'}]}}]};
test('results require the current conversation and a real execution receipt',()=>{
 assert.equal(projectVoiceResult(result,'another-thread'),null);assert.equal(projectVoiceResult({...result,runId:null},'owner-thread'),null);
 const p=projectVoiceResult(result,'owner-thread');assert.equal(p.runId,'receipt-1');assert.equal(p.sources[0].url,'https://example.com/readme');assert.doesNotMatch(JSON.stringify(p),/never display|privatePayload|arguments/);assert.equal(p.charts,undefined);
});
test('source links reject credentials and unsafe protocols; failed tools are not evidence',()=>{
 const r={...result,toolCalls:[{name:'read',status:'failed',result:{sources:[{id:'failed'}]}},{name:'read',status:'completed',result:{sources:[{id:'bad1',url:'javascript:alert(1)'},{id:'bad2',url:'https://user:password@example.com/'},{id:'good',url:'https://example.com/'}]}}]};
 const p=projectVoiceResult(r,'owner-thread');assert.equal(p.sources.length,3);assert.equal(p.sources[0].url,null);assert.equal(p.sources[1].url,null);assert.equal(p.sources[2].url,'https://example.com/');
});
class Node{
 constructor(doc){this.ownerDocument=doc;this.children=[];this.events={};this.attributes={};this.dataset={};this.hidden=true;this.classList={add(){}};}
 append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,f){this.events[k]=f;}focus(){}
}
test('panel clears private results on reset and cannot reopen another conversation result',()=>{
 const doc={createElement:()=>new Node(doc),createTextNode:t=>Object.assign(new Node(doc),{textContent:t})};
 const panel=new Node(doc),body=new Node(doc),close=new Node(doc),button=new Node(doc);panel.querySelector=s=>s==='[data-results-body]'?body:close;
 let conversation='owner-thread';const view=createVoiceResults({panel,button,getConversationId:()=>conversation});
 assert.equal(view.show(result,{open:true}),true);assert.equal(panel.hidden,false);assert.ok(body.children.length>0);
 view.clear();assert.equal(panel.hidden,true);assert.equal(body.children.length,0);
 view.show(result);conversation='other';button.events.click();assert.equal(body.children.length,1);assert.match(body.children[0].textContent,/Ask Nova/);
});
