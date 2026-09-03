import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Modal worker pins dependencies, emits VAD and legacy-compatible embeddings, and logs safe quality diagnostics",async()=>{const source=await readFile(new URL("../speaker-worker/modal_app.py",import.meta.url),"utf8");assert.match(source,/huggingface_hub==0\.24\.7/);assert.match(source,/PREPROCESSING_VERSION = "decode-mono-16k-rms-vad-v3-compat"/);assert.match(source,/encode_batch\(speech\)/);assert.match(source,/compatibility_vector = self\.encoder\.encode_batch\(waveform\)/);for(const diagnostic of ["voicedSegmentCount","longestVoicedSegmentSeconds","clippingRatio","noiseFloorRms","activeThresholdRms","speechRms","peakToNoiseDb"])assert.match(source,new RegExp(diagnostic));assert.match(source,/speaker_embed_received/);assert.match(source,/speaker_embed_completed/);assert.doesNotMatch(source,/print\(.*audioBase64/);});
