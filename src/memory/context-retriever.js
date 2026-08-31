import { NOVA_COMMUNICATION_POLICY } from "../identity/communication-policy.js";

function ownerContext(profile, message) {
  const query = message.toLowerCase();
  const facts = profile.facts || {};
  const context = {
    ownerId: profile.id,
    fullName: profile.fullName,
    preferredName: profile.preferredName,
    arabicName: profile.arabicName,
    gender: facts.gender,
    currentLocation: facts.currentLocation,
    languages: facts.languages,
    profession: facts.profession,
    education: facts.education,
    communicationPreferences: profile.preferences
  };
  if (/family|background|palestin|أصل|عائل|فلسطين/i.test(query)) context.familyBackground = facts.familyBackground;
  if (/born|birth|jordan|مولود|الأردن/i.test(query)) context.bornIn = facts.bornIn;
  if (/married|wife|children|family|متزوج|زوج|أطفال|اولاد|أولاد/i.test(query)) {
    context.maritalStatus = facts.maritalStatus; context.childrenCount = facts.childrenCount;
  }
  return context;
}

export async function retrieveAgentContext({ storage, ownerId, message, projectId, memoryLimit = 6 }) {
  const profile = await storage.getOwner(ownerId);
  if (!profile) throw new Error("Owner profile is unavailable.");
  const memories = await storage.retrieveMemories(ownerId, message, { projectId, limit: memoryLimit });
  return {
    owner: ownerContext(profile, message),
    memories: memories.map(({ id, category, content, privacy, sensitivity, scope, projectId: memoryProjectId, provenance }) => ({ id, category, content, privacy, sensitivity, scope, projectId: memoryProjectId, provenance }))
  };
}

export function buildSystemContext(retrieved) {
  return `${NOVA_COMMUNICATION_POLICY}\n\nThe following is minimal private owner context selected for this request. Use it internally to assist the owner. Do not repeat private details unless relevant to the owner's request.\n${JSON.stringify(retrieved)}`;
}

