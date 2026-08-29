import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceInput, MICROPHONE_LANGUAGES } from "../assets/voice-input.js";

function localState(initial={}){const values=new Map(Object.entries(initial));return{getItem:(key)=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),value:(key)=>values.get(key)};}

test("voice input reports unsupported browsers safely",()=>{let error;const voice=createVoiceInput({onError:(value)=>{error=value;}});assert.equal(voice.supported,false);voice.start();assert.match(error,/not supported/);});
test("voice input publishes interim/final text and listening state",()=>{class Recognition{start(){this.onstart();}stop(){this.onend();}}const text=[];const states=[];const voice=createVoiceInput({SpeechRecognition:Recognition,onText:(value)=>text.push(value),onState:(value)=>states.push(value)});voice.start();voice.supported;const recognitionState=states[0];assert.equal(recognitionState,"listening");voice.stop();assert.equal(states.at(-1),"idle");});
test("voice transcript populates the same composer submitted through the normal chat client", async () => {
  let recognition; class Recognition { constructor(){recognition=this;} start(){this.onstart();} }
  let composer=""; const sent=[];
  const voice=createVoiceInput({SpeechRecognition:Recognition,onText:(text)=>{composer=text;}});
  voice.start();
  recognition.onresult({resultIndex:0,results:Object.assign([[{transcript:"Hello."}]],{0:Object.assign([{transcript:"Hello."}],{isFinal:true})})});
  const normalSubmit=async()=>sent.push(composer);
  await normalSubmit();
  assert.deepEqual(sent,["Hello."]);
});
test("microphone language defaults to en-GB and is applied before recognition starts",()=>{let recognition;class Recognition{constructor(){recognition=this;}start(){assert.equal(this.lang,"en-GB");}}const voice=createVoiceInput({SpeechRecognition:Recognition});voice.start();assert.equal(recognition.lang,"en-GB");});
test("Arabic and another configured microphone locale persist and apply on the next session",()=>{const storage=localState();let recognition;class Recognition{constructor(){recognition=this;}start(){}}const voice=createVoiceInput({SpeechRecognition:Recognition,storage});voice.setLanguage("ar-SA");voice.start();assert.equal(recognition.lang,"ar-SA");assert.equal(storage.value("nova.voice.inputLanguage"),"ar-SA");voice.setLanguage("fr-FR");voice.start();assert.equal(recognition.lang,"fr-FR");assert.ok(MICROPHONE_LANGUAGES.some(([,locale])=>locale==="tr-TR"));});
test("saved microphone language restores and permission errors remain contained",()=>{const storage=localState({"nova.voice.inputLanguage":"ar-SA"});let recognition;let message;class Recognition{constructor(){recognition=this;}start(){this.onstart?.();}}const voice=createVoiceInput({SpeechRecognition:Recognition,storage,onError:(value)=>{message=value;}});voice.start();assert.equal(recognition.lang,"ar-SA");recognition.onerror({error:"not-allowed"});assert.match(message,/permission was denied/);});
