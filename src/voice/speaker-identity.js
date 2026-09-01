import { randomUUID } from "node:crypto";

export const SPEAKER_UNKNOWN = Object.freeze({ state: "unknown", speakerProfileId: null, confidence: 0 });

function publicProfile(profile) {
  if (!profile) return null;
  const { representation: _representation, ...safe } = profile;
  return safe;
}

function normalized(values) {
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("A valid derived speaker representation is required.");
  }
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) throw new Error("A valid derived speaker representation is required.");
  return values.map((value) => value / magnitude);
}

function centroid(samples) {
  if (!Array.isArray(samples) || samples.length < 3) throw new Error("At least three consented voice samples are required.");
  const vectors = samples.map(normalized); const size = vectors[0].length;
  if (vectors.some((value) => value.length !== size)) throw new Error("Speaker samples must use one representation version.");
  return normalized(Array.from({ length: size }, (_, index) => vectors.reduce((sum, value) => sum + value[index], 0) / vectors.length));
}

function cosine(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return -1;
  return normalized(left).reduce((sum, value, index) => sum + value * normalized(right)[index], 0);
}

export function contextPolicyForSpeaker(match) {
  if (match?.state === "confirmed" && match?.relation === "owner") return "owner_private";
  if (match?.state === "confirmed") return "profile_scoped";
  return "public_only";
}

export function createSpeakerIdentity({ storage, ownerId, clock = () => new Date(), threshold = 0.86, ambiguityMargin = 0.05 } = {}) {
  if (!storage || !ownerId) throw new Error("Speaker identity requires storage and owner scope.");
  const audit = (action, summary, metadata = {}) => storage.appendActivity({ ownerId, action, status: "completed", summary, metadata });
  return Object.freeze({
    async enroll({ displayName, relation = "member", scope = "household", consent, consentActor, sampleRepresentations, representationVersion = "synthetic-v1" }) {
      if (consent !== true || typeof consentActor !== "string" || !consentActor.trim()) throw new Error("Explicit speaker consent is required.");
      if (typeof displayName !== "string" || !displayName.trim()) throw new Error("Speaker display name is required.");
      const profile = await storage.createSpeakerProfile({ id: randomUUID(), ownerId, displayName: displayName.trim(), relation, scope, enrollmentStatus: "enrolled", status: "active", representation: centroid(sampleRepresentations), representationVersion, consentAt: clock().toISOString(), consentActor: consentActor.trim() });
      await audit("speaker_enrolled", "A consented speaker profile was enrolled.", { speakerProfileId: profile.id, relation, representationVersion, sampleCount: sampleRepresentations.length });
      return publicProfile(profile);
    },
    async list() { return (await storage.listSpeakerProfiles(ownerId)).map(publicProfile); },
    async update(id, patch) {
      const allowed = {};
      if (typeof patch.displayName === "string" && patch.displayName.trim()) allowed.displayName = patch.displayName.trim();
      if (typeof patch.relation === "string" && patch.relation.trim()) allowed.relation = patch.relation.trim();
      const profile = await storage.updateSpeakerProfile(id, ownerId, allowed);
      if (profile) await audit("speaker_updated", "A speaker profile label was updated.", { speakerProfileId: id });
      return publicProfile(profile);
    },
    async revoke(id) {
      const profile = await storage.updateSpeakerProfile(id, ownerId, { status: "revoked", enrollmentStatus: "revoked", revokedAt: clock().toISOString(), representation: null });
      if (profile) await audit("speaker_revoked", "A speaker profile was revoked and its recognition representation removed.", { speakerProfileId: id });
      return publicProfile(profile);
    },
    async delete(id) {
      const deleted = await storage.deleteSpeakerProfile(id, ownerId);
      if (deleted) await audit("speaker_deleted", "A speaker profile and its recognition representation were deleted.", { speakerProfileId: id });
      return deleted;
    },
    async recognize(representation) {
      const probe = normalized(representation);
      const candidates = (await storage.listSpeakerProfiles(ownerId, { includeRepresentation: true })).filter((profile) => profile.status === "active" && profile.representation);
      const ranked = candidates.map((profile) => ({ profile, confidence: cosine(probe, profile.representation) })).sort((a, b) => b.confidence - a.confidence);
      const best = ranked[0]; const second = ranked[1];
      if (!best || best.confidence < threshold || (second && best.confidence - second.confidence < ambiguityMargin)) return SPEAKER_UNKNOWN;
      return { state: "confirmed", speakerProfileId: best.profile.id, displayName: best.profile.displayName, relation: best.profile.relation, scope: best.profile.scope, confidence: Math.round(best.confidence * 1000) / 1000 };
    },
    async recordUtterance(input) {
      return storage.createVoiceUtterance({ id: randomUUID(), ownerId, conversationId: input.conversationId, speakerProfileId: input.speakerProfileId || null, speakerLabel: input.speakerLabel || "unknown", confidence: Number.isFinite(input.confidence) ? input.confidence : null, text: input.text, startedAtMs: input.startedAtMs ?? null, endedAtMs: input.endedAtMs ?? null });
    }
  });
}
