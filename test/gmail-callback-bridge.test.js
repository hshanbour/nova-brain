import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApi} from '../src/http/api.js';

test('Strict-cookie Gmail bridge exposes no data and exchanges only after same-origin owner verification',async()=>{
 let actor=null,exchanges=0,received;
 const api=createApi({ownerId:'owner',connectedPreview:true,continuityPreview:true,
  config:{allowedOrigins:[],maxBodyBytes:10000,gmail:{redirectUri:'https://nova.test/api/integrations/gmail/oauth/callback'}},
  initialize:async()=>{},authorizeConsole:async()=>actor,
  gmailService:{async completeOAuth(input){exchanges++;received=input;}}
 });
 async function call(method,{origin='https://nova.test',body={code:'fixture-code',state:'fixture-state'}}={}){
  const req=Readable.from(method==='POST'?[JSON.stringify(body)]:[]);
  Object.assign(req,{url:'/api/integrations/gmail/oauth/callback?code=fixture-code&state=fixture-state',method,headers:{host:'nova.test',origin,'content-type':'application/json',cookie:'nova_gmail_oauth=fixture-session'}});
  const res={headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v){this.body=v;}};
  await api.handle(req,res);return res;
 }
 const bridge=await call('GET');assert.equal(bridge.statusCode,200);assert.equal(exchanges,0);
 assert.match(bridge.body,/credentials:'same-origin'/);assert.match(bridge.body,/history.replaceState/);
 assert.doesNotMatch(bridge.body,/fixture-code|fixture-state|fixture-session/);
 assert.equal(bridge.headers['cache-control'],'no-store');assert.match(bridge.headers['content-security-policy'],/script-src 'sha256-/);
 assert.equal((await call('POST')).statusCode,403);assert.equal(exchanges,0);
 actor={role:'owner',ownerId:'other',workspaceId:'other'};
 assert.equal((await call('POST')).statusCode,403);assert.equal(exchanges,0);
 actor={role:'owner',ownerId:'owner',workspaceId:'owner'};
 assert.equal((await call('POST',{origin:'https://attacker.test'})).statusCode,403);assert.equal(exchanges,0);
 const completed=await call('POST');assert.equal(completed.statusCode,200);assert.equal(exchanges,1);
 assert.equal(received.code,'fixture-code');assert.equal(received.state,'fixture-state');
 assert.deepEqual(JSON.parse(completed.body),{connected:true});
});
