import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

export const SPEAKER_UNKNOWN = Object.freeze({ state: "unknown", speakerProfileId: null, confidence: 0, candidateCount: 0 });

function publicProfile(profile) {
  if (!profile) return null;
  const { representation: _representation, enrollmentAttemptId: _enrollmentAttemptId, ...safe } = profile;
  return safe;
}

function publicAnonymousProfile(profile) {
  if (!profile) return null;
  const { representation: _representation, consentActor: _consentActor, ...safe } = profile;
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

export function createSpeakerIdentity({ storage, ownerId, clock = () => new Date(), threshold = 0.86, ambiguityMargin = 0.05, familiarityThreshold = 0.55, familiarityAmbiguityMargin = 0.08, embeddingKey, requireEncryption = false } = {}) {
  if (!storage || !ownerId) throw new Error("Speaker identity requires storage and owner scope.");
  const key = typeof embeddingKey === "string" && embeddingKey.length >= 32 ? createHash("sha256").update(embeddingKey).digest() : null;
  const protect = (representation) => {
    if (!key) { if (requireEncryption) throw new Error("Speaker embedding encryption is not configured."); return representation; }
    const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(representation),"utf8"),cipher.final()]);
    return { algorithm:"aes-256-gcm",iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64") };
  };
  const reveal = (stored) => {
    if (Array.isArray(stored)) return stored;
    if (!key || stored?.algorithm!=="aes-256-gcm") return null;
    try { const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(stored.iv,"base64"));decipher.setAuthTag(Buffer.from(stored.tag,"base64"));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext,"base64")),decipher.final()]).toString("utf8")); } catch { return null; }
  };
  const audit = (action, summary, metadata = {}) => storage.appendActivity({ ownerId, action, status: "completed", summary, metadata });
  const recognizeRepresentations = async (variants) => {
    const probes=variants.map(({label,representation})=>({label,representation:normalized(representation)}));
    const candidates=(await storage.listSpeakerProfiles(ownerId,{includeRepresentation:true})).map((profile)=>({...profile,representation:reveal(profile.representation)})).filter((profile)=>profile.status==="active"&&profile.representation);
    const ranked=candidates.map((profile)=>{const scores=probes.map((probe)=>({label:probe.label,confidence:cosine(probe.representation,profile.representation)})).sort((a,b)=>b.confidence-a.confidence);return{profile,...scores[0]};}).sort((a,b)=>b.confidence-a.confidence);
    const best=ranked[0];const second=ranked[1];const confidence=best?Math.round(best.confidence*1000)/1000:0;const scoreMargin=second?Math.round((best.confidence-second.confidence)*1000)/1000:null;
    const decision={confidence,candidateCount:candidates.length,threshold,ambiguityMargin,scoreMargin,bestCandidateCategory:best?(best.profile.relation==="owner"?"owner":"non_owner"):null,matchVariant:best?.label||null};
    if(!best||best.confidence<threshold)return{state:"unknown",speakerProfileId:null,...decision};
    if(second&&best.confidence-second.confidence<ambiguityMargin)return{state:"uncertain",speakerProfileId:null,...decision};
    return{state:"confirmed",speakerProfileId:best.profile.id,displayName:best.profile.displayName,relation:best.profile.relation,scope:best.profile.scope,...decision};
  };
  return Object.freeze({
    async enroll({ displayName, relation = "member", scope = "household", consent, consentActor, sampleRepresentations, representationVersion = "synthetic-v1", enrollmentAttemptId }) {
      if (consent !== true || typeof consentActor !== "string" || !consentActor.trim()) throw new Error("Explicit speaker consent is required.");
      if (typeof displayName !== "string" || !displayName.trim()) throw new Error("Speaker display name is required.");
      if(enrollmentAttemptId){const existing=await storage.getSpeakerProfileByEnrollmentAttempt(ownerId,enrollmentAttemptId);if(existing)return publicProfile(existing);}
      const profile = await storage.createSpeakerProfile({ id: randomUUID(), ownerId, displayName: displayName.trim(), relation, scope, enrollmentStatus: "enrolled", status: "active", representation: protect(centroid(sampleRepresentations)), representationVersion, consentAt: clock().toISOString(), consentActor: consentActor.trim(), enrollmentAttemptId });
      await audit("speaker_enrolled", "A consented speaker profile was enrolled.", { speakerProfileId: profile.id, relation, representationVersion, sampleCount: sampleRepresentations.length });
      return publicProfile(profile);
    },
    async list() { return (await storage.listSpeakerProfiles(ownerId)).map(publicProfile); },
    async getByEnrollmentAttempt(enrollmentAttemptId){return publicProfile(await storage.getSpeakerProfileByEnrollmentAttempt(ownerId,enrollmentAttemptId));},
    async isActiveProfile(id) { if(!id)return false;return (await storage.listSpeakerProfiles(ownerId)).some((profile)=>profile.id===id&&profile.status==="active"); },
    async candidateCount() { return (await storage.listSpeakerProfiles(ownerId)).filter((profile)=>profile.status==="active").length; },
    async privacyStatus() { return storage.speakerPrivacyStatus(ownerId); },
    async purgeInvalidOwnerEnrollment() { return storage.purgeInvalidOwnerSpeakerEnrollment(ownerId); },
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
      return recognizeRepresentations([{label:"vad_v3",representation}]);
    },
    async recognizeMany(variants){if(!Array.isArray(variants)||!variants.length)throw new Error("At least one speaker representation is required.");return recognizeRepresentations(variants.map((item,index)=>({label:typeof item?.label==="string"?item.label:`variant_${index}`,representation:item?.representation})));},
    async rememberAnonymous({ representation, representationVersion, consent, consentActor, selfReportedName }) {
      if (consent !== true || typeof consentActor !== "string" || !consentActor.trim()) return { state:"consent_required",anonymousSpeakerId:null,confidence:0,candidateCount:0,threshold:familiarityThreshold,ambiguityMargin:familiarityAmbiguityMargin };
      const probe=normalized(representation);const profiles=(await storage.listAnonymousSpeakerProfiles(ownerId,{includeRepresentation:true})).map((profile)=>({...profile,representation:reveal(profile.representation)})).filter((profile)=>profile.status==="active"&&profile.representation);
      const ranked=profiles.map((profile)=>({profile,confidence:cosine(probe,profile.representation)})).sort((a,b)=>b.confidence-a.confidence);const best=ranked[0];const second=ranked[1];const confidence=best?Math.round(best.confidence*1000)/1000:0;const scoreMargin=second?Math.round((best.confidence-second.confidence)*1000)/1000:null;const diagnostics={confidence,candidateCount:profiles.length,threshold:familiarityThreshold,ambiguityMargin:familiarityAmbiguityMargin,scoreMargin};
      if(best&&best.confidence>=familiarityThreshold&&second&&best.confidence-second.confidence<familiarityAmbiguityMargin)return{state:"uncertain",anonymousSpeakerId:null,...diagnostics};
      const timestamp=clock().toISOString();const alias=typeof selfReportedName==="string"&&selfReportedName.trim()?selfReportedName.trim().slice(0,80):null;
      if(best&&best.confidence>=familiarityThreshold){const count=Math.max(1,Number(best.profile.encounterCount)||1);const updatedRepresentation=normalized(best.profile.representation.map((value,index)=>(value*count+probe[index])/(count+1)));const updated=await storage.updateAnonymousSpeakerProfile(best.profile.id,ownerId,{representation:protect(updatedRepresentation),lastSeenAt:timestamp,encounterCount:count+1,...(!best.profile.selfReportedName&&alias?{selfReportedName:alias}:{})});await audit("anonymous_speaker_recognized","A consented recurring anonymous voice was recognized.",{anonymousSpeakerId:updated.id,encounterCount:updated.encounterCount});return{state:"known_anonymous",anonymousSpeakerId:updated.id,stableLabel:updated.stableLabel,selfReportedName:updated.selfReportedName,...diagnostics};}
      const id=randomUUID();const created=await storage.createAnonymousSpeakerProfile({id,ownerId,stableLabel:`anonymous_speaker_${id.slice(0,8)}`,representation:protect(probe),representationVersion,status:"active",consentAt:timestamp,consentActor:consentActor.trim().slice(0,120),selfReportedName:alias,firstSeenAt:timestamp,lastSeenAt:timestamp,encounterCount:1});await audit("anonymous_speaker_created","A consented anonymous recurring voiceprint was created.",{anonymousSpeakerId:created.id,representationVersion});return{state:"first_time_unknown",anonymousSpeakerId:created.id,stableLabel:created.stableLabel,selfReportedName:created.selfReportedName,...diagnostics};
    },
    async listAnonymous(){return(await storage.listAnonymousSpeakerProfiles(ownerId)).map(publicAnonymousProfile);},
    async isActiveAnonymous(id){if(typeof id!=="string"||!id)return false;return(await storage.listAnonymousSpeakerProfiles(ownerId)).some((profile)=>profile.id===id&&profile.status==="active");},
    async deleteAnonymous(id){const deleted=await storage.deleteAnonymousSpeakerProfile(id,ownerId);if(deleted)await audit("anonymous_speaker_deleted","An anonymous recurring voiceprint and familiarity metadata were deleted.",{anonymousSpeakerId:id});return deleted;},
    async recordUtterance(input) {
      return storage.createVoiceUtterance({ id: randomUUID(), ownerId, conversationId: input.conversationId, speakerProfileId: input.speakerProfileId || null, speakerLabel: input.speakerLabel || "unknown", confidence: Number.isFinite(input.confidence) ? input.confidence : null, text: input.text, startedAtMs: input.startedAtMs ?? null, endedAtMs: input.endedAtMs ?? null });
    }
  });
}
