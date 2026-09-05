import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceControl } from "../assets/voice-control.js";

test("VoiceControl is the sole checkpoint owner across candidate pause resume and expiry",()=>{
  let clock=0;const control=createVoiceControl({now:()=>clock,ttlMs:100});
  control.replace({assistantTurnId:"turn-1",createdAt:clock,chunkIndex:2,status:"active"});
  control.update({interruptedAt:clock,status:"control_candidate"});
  control.update({pausedAt:clock,status:"paused_waiting_for_user"});
  assert.equal(control.isPaused(),true);assert.equal(control.isFresh(),true);
  control.update({status:"active",resumeCount:1});
  assert.deepEqual({turn:control.current().assistantTurnId,chunk:control.current().chunkIndex,resumes:control.current().resumeCount},{turn:"turn-1",chunk:2,resumes:1});
  clock=101;assert.equal(control.isFresh(),false);control.clear();assert.equal(control.current(),null);
});
