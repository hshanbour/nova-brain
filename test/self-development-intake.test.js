import test from "node:test";
import assert from "node:assert/strict";
import {createSelfDevelopmentIntake,SELF_DEVELOPMENT_INTAKE_SCHEMAS} from "../src/autonomy/self-development-intake.js";

const provider=(outputs,calls=[])=>({async generate(input){calls.push(input);return{type:"final",message:JSON.stringify(outputs.shift()),providerUsage:{model:"gpt-6-luna",stage:"intake",inputTokens:100,cachedInputTokens:0,outputTokens:40,reasoningTokens:0,totalTokens:140}};}});
const ready=(extra={})=>({status:"ready",intent:"implementation",objective:"Implement the Console card",acceptanceCriteria:["The card updates in place."],constraints:[{type:"exclude",requirement:"Do not touch Voice."}],explicitPaths:[],focusedTests:[],searchTerms:["console activity"],clarificationQuestion:"",...extra});

test("chat-native intake returns a strict structured specification and telemetry",async()=>{
  const calls=[],intake=createSelfDevelopmentIntake({modelProvider:provider([ready()],calls)}),result=await intake.specify("Implement a Console card without changing Voice");
  assert.equal(result.status,"ready");assert.equal(result.intent,"implementation");assert.deepEqual(result.constraints,[{type:"exclude",requirement:"Do not touch Voice."}]);assert.equal(result.providerUsage.model,"gpt-6-luna");assert.equal(calls[0].stage,"intake");assert.equal(calls[0].responseFormat.strict,true);assert.deepEqual(calls[0].responseFormat.schema,SELF_DEVELOPMENT_INTAKE_SCHEMAS.intake);
});

test("explicit paths are accepted only when verbatim in the user request",async()=>{
  const goal="Implement the card in assets/console.js and verify test/console-static.test.js";
  const valid=createSelfDevelopmentIntake({modelProvider:provider([ready({explicitPaths:["assets/console.js"],focusedTests:["test/console-static.test.js"]})])});
  assert.deepEqual((await valid.specify(goal)).explicitPaths,["assets/console.js"]);
  const invented=createSelfDevelopmentIntake({modelProvider:provider([ready({explicitPaths:["assets/invented.js"],focusedTests:["test/invented.test.js"]})])}),result=await invented.specify(goal);
  assert.deepEqual(result.explicitPaths,[]);assert.deepEqual(result.focusedTests,[]);assert.deepEqual(result.scopeNormalization,{discardedExplicitPaths:1,discardedFocusedTests:1});
});

test("clear filename-free implementation request discards untrusted path guesses and remains discovery-only ready",async()=>{
  const goal="Implement a tiny accessibility improvement in Nova Console: make the New conversation control expose a keyboard-shortcut hint to assistive technology, preserve all existing behavior, add or update a focused regression test, and stop before any push or deployment.",intake=createSelfDevelopmentIntake({modelProvider:provider([ready({objective:"Add an accessible keyboard shortcut hint to the New conversation control.",acceptanceCriteria:["Assistive technology can discover the keyboard shortcut hint.","Existing New conversation behavior remains unchanged.","A focused regression test covers the hint."],constraints:[{type:"preserve",requirement:"Preserve all existing behavior."},{type:"boundary",requirement:"Stop before push or deployment."}],explicitPaths:["assets/console.js"],focusedTests:["test/console-static.test.js"],searchTerms:["New conversation","keyboard shortcut","aria-keyshortcuts"]})])}),result=await intake.specify(goal);
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
  const intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"resolved",sourcePaths:["assets/console.js"],testPaths:["test/console-static.test.js"],constraintCoverage:[{constraintIndex:0,disposition:"respected",evidencePaths:["assets/console.js"]}],unresolvedPrerequisites:[]}])}),request={userGoal:"Implement",acceptanceCriteria:["Works"],constraints:[{type:"exclude",requirement:"No Voice"}]},result=await intake.resolveScope({request,candidatePaths:["assets/console.js","assets/voice-input.js","test/console-static.test.js"]});
  assert.deepEqual([...result.sourcePaths,...result.testPaths],["assets/console.js","test/console-static.test.js"]);
  const broaden=createSelfDevelopmentIntake({modelProvider:provider([{status:"resolved",sourcePaths:["assets/new.js"],testPaths:["test/console-static.test.js"],constraintCoverage:[{constraintIndex:0,disposition:"respected",evidencePaths:[]}],unresolvedPrerequisites:[]}])});
  await assert.rejects(()=>broaden.resolveScope({request,candidatePaths:["assets/console.js","test/console-static.test.js"]}),error=>error.code==="structured_scope_invalid");
});

test("unresolvable scope is represented as a bounded blocked decision",async()=>{
  const intake=createSelfDevelopmentIntake({modelProvider:provider([{status:"blocked",sourcePaths:[],testPaths:[],constraintCoverage:[{constraintIndex:0,disposition:"blocked",evidencePaths:[]}],unresolvedPrerequisites:["No relevant focused test was discovered."]}])}),result=await intake.resolveScope({request:{userGoal:"Implement",acceptanceCriteria:["Works"],constraints:[{type:"boundary",requirement:"Frontend only"}]},candidatePaths:["assets/console.js","test/api.test.js"]});
  assert.equal(result.status,"blocked");assert.equal(result.unresolvedPrerequisites.length,1);
});
