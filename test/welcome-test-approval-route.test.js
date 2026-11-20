import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApi} from '../src/http/api.js';
test('connected approval route executes the precise owner test, denies other recipients/accounts and leaves old work held',async()=>{
 for(const variant of ['allowed','recipient','tool','foreign']){
  const executed=[],rows=[];const pending={id:'approval',ownerId:'owner',status:'pending',runId:'normal-run',tool:variant==='tool'?'sharp_cuts_campaign_send':'sharp_cuts_welcome_test_send',arguments:{recipient:variant==='recipient'?'customer@example.test':'hamodehshanbour@yahoo.com'}};
  const storage={getApproval:async()=>pending,getAutonomyTask:async()=>null,decideApproval:async()=>({...pending,status:'approved'}),getRun:async()=>({id:'normal-run',conversationId:'normal-chat'}),appendActivity:async e=>rows.push(e),updateRun:async()=>{}};
  const api=createApi({ownerId:'owner',connectedPreview:true,continuityPreview:true,config:{allowedOrigins:[],maxBodyBytes:4096},storage,initialize:async()=>{},authorizeConsole:async()=>({ownerId:variant==='foreign'?'other':'owner',workspaceId:variant==='foreign'?'other':'owner',role:'owner'}),toolRegistry:{execute:async(name,input,ctx)=>{executed.push(name);assert.equal(ctx.approvalId,'approval');return {status:'synthetic-submitted'};}}});
  const req=Readable.from([JSON.stringify({decision:'approved'})]);Object.assign(req,{url:'/api/approvals/approval/decision',method:'POST',headers:{origin:'https://nova.test',host:'nova.test','content-type':'application/json'}});const res={statusCode:200,setHeader(){},end(v){this.body=v;}};await api.handle(req,res);
  assert.equal(res.statusCode,variant==='allowed'?200:403,variant+' '+res.body);assert.equal(executed.length,variant==='allowed'?1:0);if(variant==='allowed')assert.equal(JSON.parse(res.body).execution.status,'synthetic-submitted');
 }
});
