import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the shipped panel function, including its DOM updates, without
// booting the unrelated console or using credentials.
const source=readFileSync(new URL('../assets/console.js',import.meta.url),'utf8');
const start=source.indexOf('async function loadMemoryWorkspace()');
const end=source.indexOf('\ndocument.querySelector("#profileForm").addEventListener',start);
async function panel({memoryFailure=false,candidateFailure=false}={}) {
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,value:'project_context',children:[],innerHTML:'',elements:Object.fromEntries(['preferredName','currentLocation','communication'].map(k=>[k,{value:''}])),replaceChildren(...children){this.children=children;this.innerHTML='';}});return nodes.get(id)};
 const context={document:{querySelector:node},currentProfile:null,memoryRecords:[],memoryCard:m=>m,memoryCandidateCard:c=>c,ownerMemoryClient:{
  profile:async()=>({owner:{fullName:'Synthetic Preview Owner'}}),
  list:async()=>{if(memoryFailure)throw new Error('Memory unavailable');return {memories:[{id:'synthetic-test',content:'الزيتونة'}]};},
  memoryCandidates:async()=>{if(candidateFailure)throw new Error('403 forbidden');return {candidates:[]};}
 }};
 await runInNewContext(`${source.slice(start,end)};loadMemoryWorkspace()`,context);
 return {node,context};
}
test('blocked learning candidates do not hide saved Arabic memory on initial load or refresh',async()=>{
 for(let refresh=0;refresh<2;refresh++){
  const {node,context}=await panel({candidateFailure:true});
  assert.equal(node('#memoryList').children[0].content,'الزيتونة');
  assert.equal(node('#memoryError').hidden,true);
  assert.equal(node('#memoryCandidateError').hidden,false);
  assert.equal(context.currentProfile.fullName,'Synthetic Preview Owner');
 }
});
test('memory errors remain visible without falsely reporting successful memory loading',async()=>{
 const {node}=await panel({memoryFailure:true});
 assert.equal(node('#memoryList').children.length,0);
 assert.equal(node('#memoryError').textContent,'Memory unavailable');
 assert.equal(node('#memoryCandidateError').hidden,true);
});
