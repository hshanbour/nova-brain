import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Modal worker pins dependencies, embeds normalized voiced audio, and logs safe quality diagnostics",async()=>{const source=await readFile(new URL("../speaker-worker/modal_app.py",import.meta.url),"utf8");assert.match(source,/huggingface_hub==0\.24\.7/);assert.match(source,/PREPROCESSING_VERSION = "decode-mono-16k-rms-vad-v2"/);assert.match(source,/encode_batch\(speech\)/);assert.doesNotMatch(source,/encode_batch\(waveform\)/);assert.match(source,/speaker_embed_received/);assert.match(source,/speaker_embed_completed/);assert.match(source,/silenceRatio/);assert.doesNotMatch(source,/print\(.*audioBase64/);});
