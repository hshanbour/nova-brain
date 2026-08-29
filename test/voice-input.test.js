import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceInput } from "../assets/voice-input.js";

test("voice input reports unsupported browsers safely",()=>{let error;const voice=createVoiceInput({onError:(value)=>{error=value;}});assert.equal(voice.supported,false);voice.start();assert.match(error,/not supported/);});
test("voice input publishes interim/final text and listening state",()=>{class Recognition{start(){this.onstart();}stop(){this.onend();}}const text=[];const states=[];const voice=createVoiceInput({SpeechRecognition:Recognition,onText:(value)=>text.push(value),onState:(value)=>states.push(value)});voice.start();voice.supported;const recognitionState=states[0];assert.equal(recognitionState,"listening");voice.stop();assert.equal(states.at(-1),"idle");});
