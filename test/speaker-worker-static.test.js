import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Modal worker pins compatible model dependencies and logs only safe request correlation",async()=>{const source=await readFile(new URL("../speaker-worker/modal_app.py",import.meta.url),"utf8");assert.match(source,/huggingface_hub==0\.24\.7/);assert.match(source,/speaker_embed_received/);assert.match(source,/speaker_embed_completed/);assert.doesNotMatch(source,/print\(.*audioBase64/);});
