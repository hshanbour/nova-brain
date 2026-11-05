import test from "node:test";
import assert from "node:assert/strict";
import { retrieveSpeakerContext, buildSpeakerSafeSystemContext } from "../src/memory/context-retriever.js";

test("speaker context exposes only exact profile-scoped consented memories", async () => {
  const storage = { async retrieveMemories() { return [
    { id: "wife", content: "Prefers Arabic", category: "preference", evidence: { speakerProfileId: "speaker-wife" }, privacy: "restricted" },
    { id: "owner", content: "Owner private fact", category: "identity", evidence: { speakerProfileId: "speaker-owner" }, privacy: "private" },
    { id: "generic", content: "Unscoped private fact", category: "identity", evidence: {}, privacy: "private" },
  ]; } };
  const context = await retrieveSpeakerContext({ storage, ownerId: "owner", speakerProfile: { id: "speaker-wife", displayName: "Wife", relation: "family", status: "active" }, message: "hello" });
  assert.deepEqual(context.memories.map((item) => item.id), ["wife"]);
  const prompt = buildSpeakerSafeSystemContext({ speaker_label: "enrolled_member" }, context);
  assert.match(prompt, /Prefers Arabic/);
  assert.doesNotMatch(prompt, /Owner private fact|Unscoped private fact/);
});

test("unknown or inactive speakers receive no identity memory", async () => {
  const storage = { async retrieveMemories() { throw new Error("must not query"); } };
  assert.equal(await retrieveSpeakerContext({ storage, ownerId: "owner", speakerProfile: null, message: "hello" }), null);
  assert.equal(await retrieveSpeakerContext({ storage, ownerId: "owner", speakerProfile: { id: "x", status: "revoked" }, message: "hello" }), null);
});
