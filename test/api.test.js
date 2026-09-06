import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";
import { createApi } from "../src/http/api.js";
import { OpenAIProviderError } from "../src/providers/openai-model-provider.js";

function request({ method, url, body, headers = {} }) {
  const stream = Readable.from(body ? [body] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function response() {
  const headers = new Map();
  let body = "";

  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(value = "") {
      body += value;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    }
  };
}

test("health endpoint returns an online response with defensive headers", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "GET", url: "/api/health" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(JSON.parse(res.body), {
    name: "Nova Brain",
    status: "online",
    provider: "mock",
    storage: { provider: "memory", durable: false, status: "ready" }
  });
});

test("authenticated POST probe is non-mutating and returns a request id", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "POST", url: "/api/auth/probe" }), res);

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("browser voice timing telemetry logs only bounded numeric measurements",async()=>{const entries=[];const app=createApi({agent:{tools:{list(){return[];}},async run(){throw new Error("unused");}},config:{allowedOrigins:[],maxBodyBytes:64*1024},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",logger:{info(...args){entries.push(args);},error(){}}});const res=response();await app.handle(request({method:"POST",url:"/api/voice/telemetry",headers:{"content-type":"application/json"},body:JSON.stringify({turnId:7,stage:"audio-started",measurements:{speechEndToPlayback:2345.67,secret:"not-a-number",negative:-1,huge:999999}})}),res);assert.equal(res.statusCode,200);assert.deepEqual(entries[0],["Nova browser voice timing",{requestId:res.headers.get("x-request-id"),turnId:7,stage:"audio-started",measurements:{speechEndToPlayback:2345.7}}]);});

test("browser barge telemetry preserves safe fractional RMS diagnostics",async()=>{const entries=[];const app=createApi({agent:{tools:{list(){return[];}},async run(){throw new Error("unused");}},config:{allowedOrigins:[],maxBodyBytes:64*1024},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",logger:{info(...args){entries.push(args);},error(){}}});const res=response();await app.handle(request({method:"POST",url:"/api/voice/telemetry",headers:{"content-type":"application/json"},body:JSON.stringify({turnId:8,stage:"barge-candidate",measurements:{baselineRms:.01234,thresholdRms:.02789,peakUserRms:.04123,sustainedFrames:2}})}),res);assert.equal(res.statusCode,200);assert.deepEqual(entries[0][1].measurements,{baselineRms:.01234,thresholdRms:.02789,peakUserRms:.04123,sustainedFrames:2});});

test("speaker enrollment route supports a non-mutating authenticated HEAD probe", async () => {
  const app = createApp({ environment: {} });
  const res = response();
  await app.handle(request({ method: "HEAD", url: "/api/speakers/enroll" }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, "");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("agent endpoint validates and processes JSON input", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/agent",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello Brian" })
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).message, "Nova is ready. I received: Hello Brian");
});

test("API rejects malformed JSON", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/agent",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {
    error: "Request body must contain valid JSON."
  });
});

test("API rejects JSON bodies over the configured limit", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/agent",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(64 * 1024) })
    }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "Request body is too large." });
});

test("CORS allows configured origins and rejects unconfigured origins", async () => {
  const app = createApp({
    environment: { CORS_ALLOWED_ORIGINS: "https://allowed.example" }
  });
  const allowed = response();
  const rejected = response();

  await app.handle(
    request({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://allowed.example" }
    }),
    allowed
  );
  await app.handle(
    request({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://rejected.example" }
    }),
    rejected
  );

  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.equal(allowed.headers.get("vary"), "Origin");
  assert.equal(rejected.headers.has("access-control-allow-origin"), false);
});

test("missed-call endpoint validates and accepts placeholder intake", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/missed-call",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A customer", phone: "+441234567890" })
    }),
    res
  );

  assert.equal(res.statusCode, 202);
  assert.deepEqual(JSON.parse(res.body), {
    success: true,
    message: "Missed call received",
    lead: { name: "A customer", phone: "+441234567890" }
  });
});

test("unknown API routes return a defensive JSON 404", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "GET", url: "/api/unknown" }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(JSON.parse(res.body), { error: "Not found" });
});

test("API root is not used as the landing page or health endpoint", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "GET", url: "/" }), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: "Not found" });
});

test("owner profile and memory APIs expose controlled private CRUD", async () => {
  const app = createApp({ environment: {} });
  const profile = response();
  await app.handle(request({ method: "GET", url: "/api/owner/profile" }), profile);
  assert.equal(JSON.parse(profile.body).owner.fullName, "Mohammad Shanbour");
  assert.equal(profile.headers.get("cache-control"), "no-store");

  const created = response();
  await app.handle(request({ method: "POST", url: "/api/memories", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "preference", content: "Prefer compact release notes", scope: "global" }) }), created);
  assert.equal(created.statusCode, 201);
  const memory = JSON.parse(created.body).memory;
  assert.equal(memory.provenance, "owner-explicit");
  assert.equal(memory.privacy, "private");

  const updated = response();
  await app.handle(request({ method: "PATCH", url: `/api/memories/${memory.id}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "project", projectId: "nova-brain" }) }), updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(JSON.parse(updated.body).memory.projectId, "nova-brain");

  const removed = response();
  await app.handle(request({ method: "DELETE", url: `/api/memories/${memory.id}` }), removed);
  assert.deepEqual(JSON.parse(removed.body), { success: true });
});

test("conversation APIs return recents newest-first and messages chronologically without caching", async () => {
  const app = createApp({ environment: {} });
  for (const message of ["Conversation A", "Conversation B"]) {
    const sent = response();
    await app.handle(request({ method: "POST", url: "/api/agent", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) }), sent);
  }
  const recent = response(); await app.handle(request({ method: "GET", url: "/api/conversations" }), recent);
  const conversations = JSON.parse(recent.body).conversations;
  assert.equal(recent.headers.get("cache-control"), "no-store"); assert.equal(conversations.length, 2);
  assert.deepEqual(conversations.map(({ title }) => title).sort(), ["Conversation A", "Conversation B"]);
  const history = response(); await app.handle(request({ method: "GET", url: `/api/conversations/${conversations[0].id}/messages` }), history);
  assert.deepEqual(JSON.parse(history.body).messages.map(({ role }) => role), ["user", "assistant"]);
});

test("unknown and malformed conversation access returns no owner data", async () => {
  const app = createApp({ environment: {} });
  for (const path of ["/api/conversations/not-owned/messages", "/api/conversations/%2F/messages"]) {
    const res = response(); await app.handle(request({ method: "GET", url: path }), res);
    assert.equal(res.statusCode, 200); assert.deepEqual(JSON.parse(res.body), { messages: [] });
  }
});

test("memory API rejects unsupported categories and invalid project scope", async () => {
  const app = createApp({ environment: {} });
  for (const payload of [
    { category: "secret_model_fact", content: "unsafe", scope: "global" },
    { category: "goal", content: "missing project", scope: "project" }
  ]) {
    const res = response();
    await app.handle(request({ method: "POST", url: "/api/memories", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), res);
    assert.equal(res.statusCode, 400);
  }
});

test("storage failures are fail-closed and health reports degradation", async () => {
  const storage = Object.freeze({ provider: "postgres", durable: true, async initialize() { throw new Error("database-secret-value"); }, async health() { throw new Error("database-secret-value"); } });
  const app = createApp({ environment: {}, storage });
  const health = response(); await app.handle(request({ method: "GET", url: "/api/health" }), health);
  assert.deepEqual(JSON.parse(health.body).storage, { provider: "postgres", durable: true, status: "degraded" });
  const profile = response(); await app.handle(request({ method: "GET", url: "/api/owner/profile" }), profile);
  assert.equal(profile.statusCode, 503);
  assert.equal(profile.body.includes("database-secret-value"), false);
});

test("execution foundation APIs expose real projects, tools, runs, activity, and approvals without caching",async()=>{const app=createApp({environment:{}});const sent=response();await app.handle(request({method:"POST",url:"/api/agent",headers:{"content-type":"application/json"},body:JSON.stringify({message:"Inspect Nova",context:{projectId:"nova-brain"}})}),sent);for(const path of ["/api/projects","/api/tools","/api/runs","/api/activity","/api/approvals"]){const res=response();await app.handle(request({method:"GET",url:path}),res);assert.equal(res.statusCode,200);assert.equal(res.headers.get("cache-control"),"no-store");}const tools=response();await app.handle(request({method:"GET",url:"/api/tools"}),tools);assert.ok(JSON.parse(tools.body).tools.some((tool)=>tool.name==="repo_read"));const projects=response();await app.handle(request({method:"GET",url:"/api/projects"}),projects);assert.deepEqual(JSON.parse(projects.body).projects.map(({id})=>id),["nova-brain","sharp-cuts","uk-missed-call-recovery"]);});

test("autonomy APIs create inspect pause resume and cancel a durable task",async()=>{const app=createApp({environment:{}}),headers={"content-type":"application/json"};const created=response();await app.handle(request({method:"POST",url:"/api/autonomy/tasks",headers,body:JSON.stringify({title:"Synthetic repair",objective:"Repair Preview",projectId:"nova-brain",branch:"feat/nova-brain-mvp-foundation",maxSteps:5,metadata:{steps:[]}})}),created);assert.equal(created.statusCode,201);const task=JSON.parse(created.body).task;for(const action of["pause","resume","cancel"]){const res=response();await app.handle(request({method:"POST",url:`/api/autonomy/tasks/${task.id}/${action}`,headers,body:"{}"}),res);assert.equal(res.statusCode,200);}const inspected=response();await app.handle(request({method:"GET",url:`/api/autonomy/tasks/${task.id}`}),inspected);assert.equal(JSON.parse(inspected.body).task.status,"cancelled");const listed=response();await app.handle(request({method:"GET",url:"/api/autonomy/tasks?limit=10"}),listed);assert.equal(JSON.parse(listed.body).tasks[0].id,task.id);});

test("Worker migration admin route requires its scoped server credential",async()=>{let inspections=0;const app=createApi({agent:{tools:{list(){return[];}},async run(){throw new Error("unused");}},config:{allowedOrigins:[],maxBodyBytes:64*1024,workerAdminToken:"scoped-admin"},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",taskMigration:{async inspect(id){inspections+=1;return{id};}},logger:{info(){},error(){}}});const denied=response();await app.handle(request({method:"GET",url:"/api/admin/worker-tasks/task-1/migration"}),denied);assert.equal(denied.statusCode,401);assert.equal(JSON.parse(denied.body).code,"unauthorized");assert.equal(inspections,0);const allowed=response();await app.handle(request({method:"GET",url:"/api/admin/worker-tasks/task-1/migration",headers:{authorization:"Bearer scoped-admin"}}),allowed);assert.equal(allowed.statusCode,200);assert.equal(JSON.parse(allowed.body).task.id,"task-1");assert.equal(inspections,1);});

test("local Worker handoff route requires its dedicated scoped credential",async()=>{let claims=0;const app=createApi({agent:{tools:{list(){return[];}},async run(){throw new Error("unused");}},config:{allowedOrigins:[],maxBodyBytes:64*1024,localWorkerToken:"local-only"},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",localWorkerHandoff:{async claim(){claims+=1;return{claimed:false};}},logger:{info(){},error(){}}});const body=JSON.stringify({workerId:"worker",taskId:"task",idempotencyKey:"key",capabilities:[],expectedBranch:"feat/nova-brain-mvp-foundation",expectedCommit:"a".repeat(40)});const denied=response();await app.handle(request({method:"POST",url:"/api/admin/worker/handoff/claim",headers:{"content-type":"application/json"},body}),denied);assert.equal(denied.statusCode,401);assert.equal(claims,0);const allowed=response();await app.handle(request({method:"POST",url:"/api/admin/worker/handoff/claim",headers:{authorization:"Bearer local-only","content-type":"application/json"},body}),allowed);assert.equal(allowed.statusCode,200);assert.equal(claims,1);});
test("post-attestation expiry recovery route requires the scoped local Worker credential",async()=>{let recoveries=0;const app=createApi({agent:{tools:{list(){return[];}},async run(){throw new Error("unused");}},config:{allowedOrigins:[],maxBodyBytes:64*1024,localWorkerToken:"local-only"},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",postAttestationRecovery:{async recover(){recoveries+=1;return{task:{status:"queued"}};}},logger:{info(){},error(){}}});const body=JSON.stringify({taskId:"task",runtimeMinutes:15}),denied=response();await app.handle(request({method:"POST",url:"/api/admin/worker/post-attestation-expiry-recovery",headers:{"content-type":"application/json"},body}),denied);assert.equal(denied.statusCode,401);assert.equal(recoveries,0);const allowed=response();await app.handle(request({method:"POST",url:"/api/admin/worker/post-attestation-expiry-recovery",headers:{authorization:"Bearer local-only","content-type":"application/json"},body}),allowed);assert.equal(allowed.statusCode,200);assert.equal(recoveries,1);});
test("task-bound Worker tick requires scoped authentication and passes only the route task",async()=>{const calls=[];const app=createApi({agent:{tools:{list(){return[];}},async run(){throw new Error("unused");}},config:{allowedOrigins:[],maxBodyBytes:64*1024,localWorkerToken:"local-only"},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",workerRuntime:{async tickTask(id,input){calls.push({id,input});return{claimed:true};}},logger:{info(){},error(){}}});const body=JSON.stringify({idempotencyKey:"bound"}),denied=response();await app.handle(request({method:"POST",url:"/api/autonomy/worker/tasks/task-one/tick",headers:{"content-type":"application/json"},body}),denied);assert.equal(denied.statusCode,401);assert.equal(calls.length,0);const allowed=response();await app.handle(request({method:"POST",url:"/api/autonomy/worker/tasks/task-one/tick",headers:{authorization:"Bearer local-only","content-type":"application/json"},body}),allowed);assert.equal(allowed.statusCode,200);assert.deepEqual(calls,[{id:"task-one",input:{idempotencyKey:"bound"}}]);});
test("self-development API creates inspects and repairs through one service",async()=>{const calls=[];const service={async create(input){calls.push(["create",input]);return{task:{id:"self-1"}};},async get(id){calls.push(["get",id]);return{task:{id}};},async repair(id,input){calls.push(["repair",id,input]);return{task:{id,status:"queued"}};}};const app=createApi({agent:{tools:{list(){return[];}},async run(){throw new Error("unused");}},config:{allowedOrigins:[],maxBodyBytes:64*1024},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",selfDevelopment:service,logger:{info(){},error(){}}}),headers={"content-type":"application/json"};const created=response();await app.handle(request({method:"POST",url:"/api/self-development/tasks",headers,body:JSON.stringify({userGoal:"Improve"})}),created);assert.equal(created.statusCode,201);const read=response();await app.handle(request({method:"GET",url:"/api/self-development/tasks/self-1"}),read);assert.equal(read.statusCode,200);const repaired=response();await app.handle(request({method:"POST",url:"/api/self-development/tasks/self-1/repair",headers,body:JSON.stringify({evidence:"new",patch:{files:[]}})}),repaired);assert.equal(repaired.statusCode,200);assert.deepEqual(calls.map(x=>x[0]),["create","get","repair"]);});

test("API logs bounded structured OpenAI diagnostics while returning a generic error", async () => {
  const entries=[];
  const upstream=new OpenAIProviderError(400,'invalid schema sk-secret-value'); upstream.runId="run-safe-id";
  const app=createApi({
    agent:{tools:{list(){return[];}},async run(){throw upstream;}},
    config:{allowedOrigins:[],maxBodyBytes:64*1024},
    storage:{provider:"memory",durable:false}, initialize:async()=>{}, ownerId:"owner",
    logger:{error(...args){entries.push(args);}}
  });
  const res=response();
  await app.handle(request({method:"POST",url:"/api/agent",headers:{"content-type":"application/json"},body:JSON.stringify({message:"Hello."})}),res);
  assert.equal(res.statusCode,500);
  assert.deepEqual(JSON.parse(res.body),{error:"Internal server error"});
  assert.match(res.headers.get("x-request-id"),/^[0-9a-f-]{36}$/);
  assert.equal(entries[0][1].upstreamStatus,400);
  assert.equal(entries[0][1].runId,"run-safe-id");
  assert.equal(JSON.stringify(entries).includes("sk-secret-value"),false);
});
