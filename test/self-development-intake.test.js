import test from "node:test";
import assert from "node:assert/strict";
import {createSelfDevelopmentIntake,SELF_DEVELOPMENT_INTAKE_SCHEMAS} from "../src/autonomy/self-development-intake.js";

const provider=(outputs,calls=[])=>({async generate(input){calls.push(input);return{type:"final",message:JSON.stringify(outputs.shift()),providerUsage:{model:"gpt-6-luna",stage:"intake",inputTokens:100,cachedInputTokens:0,outputTokens:40,reasoningTokens:0,totalTokens:140}};}});
const ready=(extra={})=>({status:"ready",objective:"Implement the Console card",acceptanceCriteria:["The card updates in place."],constraints:[{type:"exclude",requirement:"Do not touch Voice."}],explicitPaths:[],focusedTests:[],searchTerms:["console activity"],clarificationQuestion:"",...extra});

test("chat-native intake returns a strict structured specification and telemetry",async()=>{
  const calls=[],intake=createSelfDevelopmentIntake({modelProvider:provider([ready()],calls)}),result=await intake.specify("Implement a Console card without changing Voice");
  assert.equal(result.status,"ready");assert.deepEqual(result.constraints,[{type:"exclude",requirement:"Do not touch Voice."}]);assert.equal(result.providerUsage.model,"gpt-6-luna");assert.equal(calls[0].stage,"intake");assert.equal(calls[0].responseFormat.strict,true);assert.deepEqual(calls[0].responseFormat.schema,SELF_DEVELOPMENT_INTAKE_SCHEMAS.intake);
});

test("explicit paths are accepted only when verbatim in the user request",async()=>{
  const goal="Implement the card in assets/console.js and verify test/console-static.test.js";
  const valid=createSelfDevelopmentIntake({modelProvider:provider([ready({explicitPaths:["assets/console.js"],focusedTests:["test/console-static.test.js"]})])});
  assert.deepEqual((await valid.specify(goal)).explicitPaths,["assets/console.js"]);
  const invented=createSelfDevelopmentIntake({modelProvider:provider([ready({explicitPaths:["assets/invented.js"]})])});
  await assert.rejects(()=>invented.specify(goal),error=>error.code==="structured_intake_invalid");
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
