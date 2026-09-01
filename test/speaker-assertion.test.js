import test from "node:test";
import assert from "node:assert/strict";
import { createSpeakerAssertions } from "../src/voice/speaker-assertion.js";

test("speaker assertions are signed, expiring, and cannot be upgraded by the browser",()=>{let now=1000;const assertions=createSpeakerAssertions({key:"a-secure-preview-only-key-at-least-32-bytes",clock:()=>now,ttlMs:100});const token=assertions.issue({speaker_profile_id:"wife",speaker_label:"enrolled_member",match_status:"confirmed"});assert.equal(assertions.verify(token).speaker_label,"enrolled_member");const [payload,signature]=token.split(".");const forged=Buffer.from(JSON.stringify({speaker_profile_id:"owner",speaker_label:"owner",match_status:"confirmed",exp:99999})).toString("base64url");assert.equal(assertions.verify(`${forged}.${signature}`),null);now=1101;assert.equal(assertions.verify(token),null);assert.equal(assertions.verify(`${payload}.bad`),null);});
