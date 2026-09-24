import test from "node:test";
import assert from "node:assert/strict";
import {createSelfDevelopmentIntake,SELF_DEVELOPMENT_INTAKE_SCHEMAS} from "../src/autonomy/self-development-intake.js";
import {deriveSourceCreationAuthorities} from "../src/autonomy/source-creation-authority.js";

const provider=(outputs,calls=[])=>({async generate(input){calls.push(input);return{type:"final",message:JSON.stringify(outputs.shift()),providerUsage:{model:"gpt-6-luna",stage:"intake",inputTokens:100,cachedInputTokens:0,outputTokens:40,reasoningTokens:0,totalTokens:140}};}});
const ready=(extra={})=>({status:"ready",intent:"implementation",objective:"Implement the Console card",acceptanceCriteria:["The card updates in place."],constraints:[{type:"exclude",requirement:"Do not touch Voice.",enforcements:["scope_selection"]}],explicitPaths:[],focusedTests:[],searchTerms:["console activity"],clarificationQuestion:"",...extra});

test("chat-native intake returns a strict structured specification and telemetry",async()=>{
  const calls=[],intake=createSelfDevelopmentIntake({modelProvider:provider([ready()],calls)}),result=await intake.specify("Implement a Console card without changing Voice");
  assert.equal(result.status,"ready");assert.equal(result.intent,"implementation");assert.deepEqual(result.constraints,[{type:"exclude",requirement:"Do not touch Voice.",enforcements:["scope_selection"]}]);assert.equal(result.providerUsage.model,"gpt-6-luna");assert.equal(calls[0].stage,"intake");assert.equal(calls[0].responseFormat.strict,true);assert.deepEqual(calls[0].responseFormat.schema,SELF_DEVELOPMENT_INTAKE_SCHEMAS.intake);
});

test("explicit paths are accepted only when verbatim in the user request",async()=>{
  const goal="Implement the card in index.html and assets/console.js and verify test/console-static.test.js";
  const valid=createSelfDevelopmentIntake({modelProvider:provider([ready({explicitPaths:["index.html","assets/console.js"],focusedTests:["test/console-static.test.js"]})])});
  assert.deepEqual((await valid.specify(goal)).explicitPaths,["index.html","assets/console.js"]);
  const invented=createSelfDevelopmentIntake({modelProvider:provider([ready({explicitPaths:["invented.html","assets/invented.js"],focusedTests:["test/invented.test.js"]})])}),result=await invented.specify(goal);
  assert.deepEqual(result.explicitPaths,[]);assert.deepEqual(result.focusedTests,[]);assert.deepEqual(result.scopeNormalization,{discardedExplicitPaths:2,discardedFocusedTests:1});
});

test("clear filename-free implementation request discards untrusted path guesses and remains discovery-only ready",async()=>{
  const goal="Implement a tiny accessibility improvement in Nova Console: make the New conversation control expose a keyboard-shortcut hint to assistive technology, preserve all existing behavior, add or update a focused regression test, and stop before any push or deployment.",intake=createSelfDevelopmentIntake({modelProvider:provider([ready({objective:"Add an accessible keyboard shortcut hint to the New conversation control.",acceptanceCriteria:["Assistive technology can discover the keyboard shortcut hint.","Existing New conversation behavior remains unchanged.","A focused regression test covers the hint."],constraints:[{type:"preserve",requirement:"Preserve all existing behavior.",enforcements:["preservation_assessment"]},{type:"boundary",requirement:"Stop before push or deployment.",enforcements:["omit_git_push","omit_preview_deploy"]}],explicitPaths:["assets/console.js"],focusedTests:["test/console-static.test.js"],searchTerms:["New conversation","keyboard shortcut","aria-keyshortcuts"]})])}),result=await intake.specify(goal);
  assert.equal(result.status,"ready");assert.deepEqual(result.explicitPaths,[]);assert.deepEqual(result.focusedTests,[]);assert.deepEqual(result.scopeNormalization,{discardedExplicitPaths:1,discardedFocusedTests:1});
});

test("invalid ready and clarification semantics still fail closed with a bounded reason",async()=>{
  const intake=createSelfDevelopmentIntake({modelProvider:provider([ready({clarificationQuestion:"Which control?"})])});
  await assert.rejects(()=>intake.specify("Implement the Console card"),error=>error.code==="structured_intake_invalid"&&error.safeDiagnostics?.reason==="status_question_mismatch");
});

test("structured intent is independent from normalized objective wording",async()=>{
  const intake=createSelfDevelopmentIntake({modelProvider:provider([ready({objective:"Make the requested Console behavior accessible."})])}),result=await intake.specify("Implement the requested Console accessibility behavior");
  assert.equal(result.intent,"implementation");
  assert.match(result.objective,/^Make\b/);
  assert.equal(SELF_DEVELOPMENT_INTAKE_SCHEMAS.intake.required.includes("intent"),true);
});

test("analysis-only intent remains a structured non-mutation classification",async()=>{
  const intake=createSelfDevelopmentIntake({modelProvider:provider([ready({intent:"analysis_only",objective:"Compare the existing Console options."})])}),result=await intake.specify("Analyze the existing Console options only");
  assert.equal(result.intent,"analysis_only");
});

test("scope resolution can only narrow repository-evidenced candidates and covers constraints",async()=>{
  const calls=[],intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"resolved",sourcePaths:["assets/console.js"],testPaths:["test/console-static.test.js"],constraintCoverage:[{constraintIndex:0,disposition:"respected",evidencePaths:["assets/console.js"]}],unresolvedEvidence:[]}],calls)}),request={userGoal:"Implement",acceptanceCriteria:["Works"],constraints:[{type:"exclude",requirement:"No Voice",enforcements:["scope_selection"]}]},candidateEvidence=[{path:"assets/console.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"recent conversations drawer",line:33,text:'const recentsDrawer = document.querySelector("#recentsDrawer");',truncated:false}]},{path:"assets/voice-input.js",role:"source",inventory:true,matches:[]},{path:"test/console-static.test.js",role:"focused_test",inventory:true,matches:[],relationship:{sourcePath:"assets/console.js",matchedTokens:["console"],basis:"existing_bound_commit_path_relation"}}],result=await intake.resolveScope({request,candidatePaths:["assets/console.js","assets/voice-input.js","test/console-static.test.js"],candidateEvidence});
  assert.deepEqual([...result.sourcePaths,...result.testPaths],["assets/console.js","test/console-static.test.js"]);
  const payload=JSON.parse(calls[0].message.split("\n").at(-1));
  assert.deepEqual(payload.candidateEvidence,candidateEvidence);
  const broaden=createSelfDevelopmentIntake({modelProvider:provider([{status:"resolved",sourcePaths:["assets/new.js"],testPaths:["test/console-static.test.js"],constraintCoverage:[{constraintIndex:0,disposition:"respected",evidencePaths:[]}],unresolvedEvidence:[]}])});
  await assert.rejects(()=>broaden.resolveScope({request,candidatePaths:["assets/console.js","test/console-static.test.js"]}),error=>error.code==="structured_scope_invalid");
});

test("scope resolution may authorize a new source only inside a deterministic repository envelope",async()=>{
  const request={userGoal:"Add a Twilio integration adapter and register it",acceptanceCriteria:["The Twilio adapter is registered."],constraints:[]},candidatePaths=["src/integrations/index.js","src/integrations/stripe-adapter.js","src/integrations/gmail-adapter.js","test/integrations.test.js"],candidateEvidence=[
    {path:"src/integrations/index.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"integration adapter",line:4,text:"export function registerIntegration(adapter) {}",truncated:false}]},
    {path:"src/integrations/stripe-adapter.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"integration adapter",line:1,text:"export const stripeAdapter = {};",truncated:false}]},
    {path:"src/integrations/gmail-adapter.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"integration adapter",line:1,text:"export const gmailAdapter = {};",truncated:false}]},
    {path:"test/integrations.test.js",role:"focused_test",inventory:true,matches:[],relationship:{sourcePath:"src/integrations/index.js",matchedTokens:["integration"],basis:"existing_bound_commit_path_relation"}},
  ],authorities=deriveSourceCreationAuthorities(candidatePaths,{userGoal:request.userGoal}),intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"resolved",sourcePaths:["src/integrations/index.js"],newSourcePaths:["src/integrations/twilio-adapter.js"],testPaths:["test/integrations.test.js"],constraintCoverage:[],unresolvedEvidence:[]}])}),result=await intake.resolveScope({request,candidatePaths,candidateEvidence,sourceCreationAuthorities:authorities});
  assert.deepEqual(result.newSourcePaths,["src/integrations/twilio-adapter.js"]);
  assert.equal(result.sourceCreationRecords.length,1);
  assert.deepEqual(result.sourceCreationRecords[0].evidencePaths,["src/integrations/gmail-adapter.js","src/integrations/index.js","src/integrations/stripe-adapter.js"]);
  assert.equal(result.sourceCreationRecords[0].baselineExists,false);
});

test("scope evidence cannot introduce authority or unsupported source-test relationships",async()=>{
  const request={userGoal:"Implement",acceptanceCriteria:["Works"],constraints:[]},candidatePaths=["assets/console.js","test/console-static.test.js"];
  for(const candidateEvidence of [
    [{path:"assets/console.js",role:"source",inventory:true,matches:[]},{path:"test/other.test.js",role:"focused_test",inventory:true,matches:[]}],
    [{path:"assets/console.js",role:"source",inventory:true,matches:[]},{path:"test/console-static.test.js",role:"focused_test",inventory:true,matches:[],relationship:{sourcePath:"assets/not-authorized.js",matchedTokens:["console"],basis:"existing_bound_commit_path_relation"}}],
    [{path:"assets/console.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"drawer",line:1,text:"x".repeat(241),truncated:false}]},{path:"test/console-static.test.js",role:"focused_test",inventory:true,matches:[]}],
  ]){
    const intake=createSelfDevelopmentIntake({modelProvider:provider([])});
    await assert.rejects(()=>intake.resolveScope({request,candidatePaths,candidateEvidence}),error=>error.code==="structured_scope_invalid");
  }
});

test("scope resolution rejects filename-only, truncated, and weak test evidence even when the model selects it",async()=>{
  const request={userGoal:"Implement drawer keyboard behavior",acceptanceCriteria:["Keyboard navigation works."],constraints:[]},candidatePaths=["assets/console.js","test/console-static.test.js"],resolved={status:"resolved",sourcePaths:["assets/console.js"],testPaths:["test/console-static.test.js"],constraintCoverage:[],unresolvedEvidence:[]};
  for(const candidateEvidence of [
    [{path:"assets/console.js",role:"source",inventory:true,matches:[]},{path:"test/console-static.test.js",role:"focused_test",inventory:true,matches:[],relationship:{sourcePath:"assets/console.js",matchedTokens:["console"],basis:"existing_bound_commit_path_relation"}}],
    [{path:"assets/console.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"drawer",line:1,text:"bounded partial line",truncated:true}]},{path:"test/console-static.test.js",role:"focused_test",inventory:true,matches:[],relationship:{sourcePath:"assets/console.js",matchedTokens:["console"],basis:"existing_bound_commit_path_relation"}}],
    [{path:"assets/console.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"drawer",line:1,text:"drawer handler",truncated:false}]},{path:"test/console-static.test.js",role:"focused_test",inventory:true,matches:[],relationship:null}],
  ]){
    const intake=createSelfDevelopmentIntake({modelProvider:provider([resolved])});
    await assert.rejects(()=>intake.resolveScope({request,candidatePaths,candidateEvidence}),error=>error.code==="structured_scope_invalid");
  }
});

test("a bounded ownership certificate may validate a task-relevant truncated physical line",async()=>{
  const candidatePaths=["assets/console.js","test/console-static.test.js"],candidateEvidence=[
    {path:"assets/console.js",role:"source",inventory:true,matches:[{stepId:"2:search_code",query:"drawer keyboard",line:33,text:'const recentsDrawer = document.querySelector("#recentsDrawer");',truncated:true}],ownership:{basis:"selector_binding",matchedTokens:["drawer"],stepId:"2:search_code",line:33}},
    {path:"test/console-static.test.js",role:"focused_test",inventory:true,matches:[],relationship:{sourcePath:"assets/console.js",matchedTokens:["console"],basis:"existing_bound_commit_path_relation"}},
  ],intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"resolved",sourcePaths:["assets/console.js"],testPaths:["test/console-static.test.js"],constraintCoverage:[],unresolvedEvidence:[]}])}),result=await intake.resolveScope({request:{userGoal:"Implement drawer keyboard behavior",acceptanceCriteria:["Keyboard navigation works."],constraints:[]},candidatePaths,candidateEvidence});
  assert.equal(result.status,"resolved");
  assert.deepEqual(result.sourcePaths,["assets/console.js"]);
});

test("unresolvable scope is represented as a bounded blocked decision",async()=>{
  const intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"blocked",sourcePaths:[],testPaths:[],constraintCoverage:[{constraintIndex:0,disposition:"blocked",evidencePaths:[]}],unresolvedEvidence:[{category:"focused_test",concepts:["console activity test"]}]}])}),result=await intake.resolveScope({request:{userGoal:"Implement",acceptanceCriteria:["Works"],constraints:[{type:"boundary",requirement:"Frontend only",enforcements:["scope_selection"]}]},candidatePaths:["assets/console.js","test/api.test.js"]});
  assert.equal(result.status,"blocked");assert.deepEqual(result.unresolvedEvidence,[{category:"focused_test",concepts:["console activity test"]}]);assert.equal(result.version,3);
});
test("scope recovery evidence is typed, bounded, and cannot grant path authority",async()=>{
  const request={userGoal:"Implement",acceptanceCriteria:["Works"],constraints:[]},candidates=["assets/console.js","test/console-static.test.js"];
  for(const unresolvedEvidence of [
    [{category:"focused_test",concepts:["assets/api-client.js"]}],
    [{category:"unknown",concepts:["task status client"]}],
    [{category:"existing_contract",concepts:["task status client", "x".repeat(81)]}],
  ]){
    const intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"blocked",sourcePaths:[],testPaths:[],constraintCoverage:[],unresolvedEvidence}])});
    await assert.rejects(()=>intake.resolveScope({request,candidatePaths:candidates}),error=>error.code==="structured_scope_invalid");
  }
});
test("scope resolution delegates preservation and delivery constraints to their bound runtime owners",async()=>{
  const calls=[],constraints=[
    {type:"preserve",requirement:"Preserve existing behavior.",enforcements:["preservation_assessment"]},
    {type:"boundary",requirement:"Stop before push or deployment.",enforcements:["omit_git_push","omit_preview_deploy"]},
  ],intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"resolved",sourcePaths:["assets/console.js"],testPaths:["test/console-static.test.js"],constraintCoverage:[],unresolvedEvidence:[]}],calls)}),result=await intake.resolveScope({request:{userGoal:"Implement",acceptanceCriteria:["Works"],constraints},candidatePaths:["assets/console.js","test/console-static.test.js"]});
  assert.equal(result.status,"resolved");
  assert.deepEqual(result.constraintCoverage,[]);
  assert.deepEqual(result.constraintBindings.map(item=>item.enforcements),[["preservation_assessment"],["omit_git_push","omit_preview_deploy"]]);
  assert.deepEqual(JSON.parse(calls[0].message.split("\n").at(-1)).scopeConstraints,[]);
});
test("unsupported or incomplete constraint enforcement fails closed at intake",async()=>{
  for(const constraints of [
    [{type:"preserve",requirement:"Preserve behavior.",enforcements:["scope_selection"]}],
    [{type:"boundary",requirement:"Stop before push.",enforcements:["omit_git_push"]}],
    [{type:"boundary",requirement:"Use an unknown policy.",enforcements:["unknown"]}],
  ]){
    const intake=createSelfDevelopmentIntake({modelProvider:provider([ready({constraints})])});
    await assert.rejects(()=>intake.specify("Implement the Console change"),error=>error.code==="structured_intake_invalid");
  }
});
