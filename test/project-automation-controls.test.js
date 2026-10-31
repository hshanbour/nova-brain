import test from "node:test";
import assert from "node:assert/strict";
import {createProjectAutomationControls} from "../src/automation/project-automation-controls.js";

function fixture(){
  const events=[];
  const storage={
    async listProjects(){return[{id:"sharp-cuts-web"},{id:"nova-digital-services-uk"}];},
    async listActivity(_ownerId,{projectId}){return events.filter(event=>event.projectId===projectId).toReversed();},
    async appendActivity(input){const event={...input,id:`event-${events.length+1}`,createdAt:new Date(2026,9,31,12,events.length).toISOString()};events.push(event);return event;}
  };
  return{service:createProjectAutomationControls({storage,ownerId:"owner"}),events};
}

test("project automation controls default fail closed and persist a full project-scoped snapshot",async()=>{
  const {service,events}=fixture();
  const initial=await service.current("sharp-cuts-web");
  assert.deepEqual(initial.controls,{master:false,publishing:false,messaging:false,marketing:false,reminders:false});
  assert.equal(await service.allows("sharp-cuts-web","publishing"),false);
  const updated=await service.update("sharp-cuts-web",{controls:{master:true,publishing:true}});
  assert.equal(updated.effective.publishing,true);
  assert.equal(updated.effective.messaging,false);
  assert.equal(events.length,1);
  assert.equal(events[0].projectId,"sharp-cuts-web");
  assert.equal(events[0].metadata.externalSideEffects,false);
  assert.equal(await service.allows("nova-digital-services-uk","publishing"),false);
});

test("turning the master switch off preserves section choices but blocks effective execution",async()=>{
  const {service}=fixture();
  await service.update("sharp-cuts-web",{controls:{master:true,publishing:true,marketing:true}});
  const disabled=await service.update("sharp-cuts-web",{controls:{master:false}});
  assert.equal(disabled.controls.publishing,true);
  assert.equal(disabled.effective.publishing,false);
  assert.equal(disabled.safety.missedWorkExecution,false);
});

test("unknown controls and projects are rejected",async()=>{
  const {service}=fixture();
  await assert.rejects(()=>service.update("sharp-cuts-web",{controls:{spend:true}}),error=>error.code==="automation_control_invalid");
  await assert.rejects(()=>service.current("missing"),error=>error.code==="automation_project_not_found");
});
