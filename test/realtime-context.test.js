import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createProjectService } from "../src/projects/project-service.js";
import { readRealtimeContext } from "../src/voice/realtime-context.js";
import { explicitVoiceLanguage } from "../assets/voice-language.js";
import { createApi } from "../src/http/api.js";
import { createRealtimeVoiceService } from "../src/voice/realtime-voice-service.js";

async function fixture() {
  const storage = createInMemoryStorage();
  await storage.initialize({owner:{id:"owner",preferences:{arabic:"Jordanian Arabic"}},projects:[{id:"pgk",name:"Plumber Growth Kit",description:"Accepted project description"},{id:"other",name:"Other project"}],memories:[]});
  for(const m of [{id:"purpose",scope:"system",category:"project_context",content:"Nova coordinates approved business execution."},{id:"pgk-memory",scope:"project",projectId:"pgk",category:"project_context",content:"Plumber Growth Kit saved milestone"},{id:"other-memory",scope:"project",projectId:"other",category:"project_context",content:"Other project's private milestone"}]) await storage.createMemory({...m,ownerId:"owner",status:"active"});
  return {storage,ownerId:"owner",projectService:createProjectService({storage,ownerId:"owner"})};
}

test("owner console context includes saved purpose and preferences, with exact project isolation", async()=>{
  const f=await fixture(),boot=await readRealtimeContext(f);
  assert.equal(boot.replyLanguage,"ar"); assert.equal(boot.purpose[0].id,"purpose");
  assert.equal(boot.authority,"authenticated_console_read_only");
  const context=await readRealtimeContext({...f,message:"شو بتتذكري عن Plumber Growth Kit؟"});
  assert.deepEqual(context.projects.map(p=>p.id),["pgk"]);
  assert.ok(context.memories.some(m=>m.id==="pgk-memory"));
  assert.ok(!JSON.stringify(context).includes("Other project's private milestone"));
  const missing=await readRealtimeContext({...f,message:"What about Project Not Stored?"});
  assert.equal(missing.resolution,"unresolved");
  assert.ok(!missing.memories.some(m=>m.projectId));
});

test("language continuity ignores noise/project names and only reads this owner's conversation",async()=>{
  const f=await fixture();
  assert.equal(explicitVoiceLanguage("خليتي احكي عربي لا ترجع تعيدي هاي الشغلة."),"ar");
  assert.equal(explicitVoiceLanguage("Please continue in English"),"en");
  assert.equal(explicitVoiceLanguage("Arfeminana"),null);
  assert.equal(explicitVoiceLanguage("شو بتتذكري عن Plumber Growth Kit؟"),null);
  await f.storage.ensureConversation({id:"mine",ownerId:"owner"});
  await f.storage.appendMessage({conversationId:"mine",ownerId:"owner",role:"user",content:"Please continue in English"});
  await f.storage.appendMessage({conversationId:"mine",ownerId:"owner",role:"user",content:"Arfeminana"});
  assert.equal((await readRealtimeContext({...f,conversationId:"mine"})).replyLanguage,"en");
  await f.storage.ensureConversation({id:"not-mine",ownerId:"someone-else"});
  await f.storage.appendMessage({conversationId:"not-mine",ownerId:"someone-else",role:"user",content:"Please speak English"});
  assert.equal((await readRealtimeContext({...f,conversationId:"not-mine"})).replyLanguage,"ar");
  assert.deepEqual((await readRealtimeContext({...f,conversationId:"not-mine"})).conversation,[]);
  assert.equal((await readRealtimeContext({...f,conversationId:"mine"})).conversation[0].content,"Please continue in English");
});

test("Arabic project pronunciation uses a catalogue ID but cannot cross owner boundaries",async()=>{
  const f=await fixture();
  const result=await readRealtimeContext({...f,message:"شو بتتذكري عن بلامر غروث كيت؟",lookupProjectId:"pgk"});
  assert.equal(result.resolution,"resolved");assert.ok(result.memories.some(m=>m.id==="pgk-memory"));
  const absent=await readRealtimeContext({...f,message:"tell me",lookupProjectId:"another-owner-project"});
  assert.equal(absent.resolution,"missing");assert.deepEqual(absent.projects,[]);assert.ok(!absent.memories.some(m=>m.projectId));
});

function response(){return {statusCode:200,headers:{},body:"",setHeader(k,v){this.headers[k]=v},end(v=""){this.body+=v}}}
function request(path,body,origin="https://nova.test"){const r=Readable.from([JSON.stringify(body)]);r.method="POST";r.url=path;r.headers={host:"nova.test",origin,"content-type":"application/json"};return r}
test("context endpoint is Preview-only, same-origin, read-only and ignores supplied owner IDs",async()=>{
  const f=await fixture(); let ran=0;
  const base={...f,agent:{tools:{list(){return[]}},async run(){ran++}},initialize:async()=>{},config:{allowedOrigins:[],maxBodyBytes:10000},logger:{info(){},error(){}}};
  let app=createApi(base),r=response();await app.handle(request("/api/voice/realtime/context",{message:"Plumber Growth Kit"}),r);assert.equal(r.statusCode,404);
  app=createApi({...base,realtimeAccountContext:true,speakerAssertions:{verify:a=>a==="signed-owner"?{match_status:"confirmed",speaker_label:"owner",speaker_profile_id:"profile"}:null},speakerIdentity:{get:async()=>({status:"active",relation:"owner"})}});r=response();await app.handle(request("/api/voice/realtime/context",{message:"Plumber Growth Kit"},"https://evil.test"),r);assert.equal(r.statusCode,403);
  r=response();await app.handle(request("/api/voice/realtime/context",{message:"Plumber Growth Kit",ownerId:"other-owner",context:{projectId:"other",speaker:{assertion:"signed-owner"}}}),r);assert.equal(r.statusCode,200);assert.deepEqual(JSON.parse(r.body).projects.map(p=>p.id),["pgk"]);assert.equal(JSON.parse(r.body).speakerIdentity.status,"verified_owner");assert.equal(ran,0);
  r=response();await app.handle(request("/api/voice/realtime/context",{message:"Plumber Growth Kit"}),r);assert.equal(r.statusCode,403);assert.doesNotMatch(r.body,/private-fact/);
});

test("realtime provider receives saved evidence and context tool without changing audio configuration",async()=>{
  const f=await fixture();let body;
  const service=createRealtimeVoiceService({apiKey:"test",fetchImpl:async(_,o)=>{body=JSON.parse(o.body);return Response.json({value:"ek_test"})}});
  const result=await service.createClientSecret({accountContext:await readRealtimeContext(f)});
  assert.equal(result.replyLanguage,"ar");assert.match(body.session.instructions,/Nova coordinates approved business execution/);
  assert.ok(body.session.tools.some(t=>t.name==="nova_context"));
  assert.match(body.session.instructions,/unclear or Latin-script transcriptions are NOT language-change requests/);
  assert.equal(body.session.audio.input.turn_detection.silence_duration_ms,450);
  assert.deepEqual(body.session.audio.input.transcription.languages,["ar","en"]);
  assert.ok(body.session.audio.input.transcription.keywords.includes("Plumber Growth Kit"));
  assert.match(body.session.instructions,/correction replaces the mistaken interpretation/);
  assert.match(body.session.instructions,/then stop and wait/);
});
