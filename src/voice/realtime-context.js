import { retrieveAgentContext } from "../memory/context-retriever.js";
import { explicitVoiceLanguage } from "../../assets/voice-language.js";

const compactMemory = ({ id, content, provenance, projectId, scope }) => ({ id, content: String(content || "").slice(0, 2500), provenance, projectId, scope });

// This is the protected owner console's read-only context, not a speaker assertion.
// Never expose it to telephone/WhatsApp sessions or use it to authorise an action.
export async function readRealtimeContext({ storage, projectService, ownerId, message = "", conversationId = null }) {
  const [profile, projects, systemMemories, history] = await Promise.all([
    storage.getOwner(ownerId), storage.listProjects(ownerId),
    storage.listMemories(ownerId, { scope: "system", limit: 12 }),
    conversationId ? storage.listMessages(conversationId, ownerId, { limit: 12 }) : [],
  ]);
  if (!profile) throw new Error("Owner context is unavailable.");
  const resolution = message ? await projectService.resolve({ message }) : { status: "unresolved" };
  const projectId = resolution.status === "resolved" ? resolution.project.id : null;
  const retrieved = message ? await retrieveAgentContext({ storage, ownerId, message, projectId: projectId || undefined }) : null;
  const memories = (retrieved?.memories || []).filter(m => !m.projectId || m.projectId === projectId);
  const languageRequests = history.filter(m => m.role === "user" && explicitVoiceLanguage(m.content)).slice(-3).map(m => String(m.content).slice(0, 500));
  const savedLanguage = profile.preferences?.preferredLanguage || profile.preferences?.language || (profile.preferences?.arabic ? "ar" : null);
  const replyLanguage = languageRequests.map(explicitVoiceLanguage).at(-1) || (/^(?:ar|Arabic)/i.test(savedLanguage || "") ? "ar" : /^(?:en|English)/i.test(savedLanguage || "") ? "en" : null);
  return {
    authority: "authenticated_console_read_only",
    speakerIdentity: "not_established_by_account_access",
    preferences: profile.preferences || {},
    replyLanguage,
    purpose: systemMemories.filter(m => m.status === "active" && ["project_context", "reusable_instruction"].includes(m.category)).slice(0, 4).map(compactMemory),
    projects: projects.filter(p => !projectId || p.id === projectId).map(({ id, name, description }) => ({ id, name, description })),
    resolution: resolution.status,
    memories: memories.map(compactMemory),
    recentWork: projectId ? retrieved?.recentWork || [] : [],
    // Carry only language instructions into a new realtime session, not stale assistant claims.
    languageRequests,
    evidenceLimits: "Only these saved records are evidence. Descriptions and past work are not proof of current operational status. If a project is absent or has no accepted memory, state that precise gap; never invent its purpose or claim all project context is unavailable.",
  };
}
