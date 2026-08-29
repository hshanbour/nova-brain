import { randomUUID } from "node:crypto";
import { rankRelevantMemories } from "../memory/relevance.js";

function copy(value) { return value === undefined ? undefined : structuredClone(value); }
function now(clock) { return clock().toISOString(); }

export function createInMemoryStorage({ clock = () => new Date() } = {}) {
  const owners = new Map(); const projects = new Map(); const conversations = new Map(); const messages = new Map(); const memories = new Map();
  let sequence = 0;

  return Object.freeze({
    provider: "memory",
    durable: false,
    async initialize({ owner, projects: seedProjects = [], memories: seedMemories = [] } = {}) {
      if (owner && !owners.has(owner.id)) {
        const timestamp = now(clock);
        owners.set(owner.id, { ...copy(owner), createdAt: timestamp, updatedAt: timestamp });
      }
      for (const project of seedProjects) if (!projects.has(project.id)) projects.set(project.id, { ...copy(project), ownerId: owner.id, createdAt: now(clock), updatedAt: now(clock) });
      for (const memory of seedMemories) if (!memories.has(memory.id)) memories.set(memory.id, { ...copy(memory), ownerId: owner.id, createdAt: now(clock), updatedAt: now(clock) });
    },
    async health() { return { provider: "memory", durable: false, status: "ready" }; },
    async getOwner(ownerId) { return copy(owners.get(ownerId) || null); },
    async updateOwner(ownerId, patch) {
      const current = owners.get(ownerId); if (!current) return null;
      const updated = { ...current, ...copy(patch), id: ownerId, createdAt: current.createdAt, updatedAt: now(clock) };
      owners.set(ownerId, updated); return copy(updated);
    },
    async ensureConversation({ id = randomUUID(), ownerId, title = null }) {
      const current = conversations.get(id);
      if (current) return current.ownerId === ownerId ? copy(current) : null;
      const timestamp = now(clock); const conversation = { id, ownerId, title, createdAt: timestamp, updatedAt: timestamp };
      conversations.set(id, conversation); messages.set(id, []); return copy(conversation);
    },
    async listConversations(ownerId, { limit = 20 } = {}) {
      return [...conversations.values()].filter((item) => item.ownerId === ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, limit).map(copy);
    },
    async appendMessage({ conversationId, ownerId, role, content }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) throw new Error("Conversation not found.");
      const entry = { id: randomUUID(), conversationId, ownerId, role, content, sequence: ++sequence, createdAt: now(clock) };
      messages.set(conversationId, [...(messages.get(conversationId) || []), entry]);
      conversation.updatedAt = entry.createdAt; return copy(entry);
    },
    async listMessages(conversationId, ownerId, { limit = 30, offset = 0 } = {}) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) return [];
      const history = messages.get(conversationId) || []; const end = history.length - offset; const start = Math.max(0, end - limit);
      return end <= 0 ? [] : history.slice(start, end).map(copy);
    },
    async createMemory(input) {
      const timestamp = now(clock); const memory = { id: input.id || randomUUID(), ...copy(input), createdAt: timestamp, updatedAt: timestamp };
      memories.set(memory.id, memory); return copy(memory);
    },
    async getMemory(id, ownerId) { const memory = memories.get(id); return copy(memory?.ownerId === ownerId && memory.status !== "deleted" ? memory : null); },
    async listMemories(ownerId, { category, scope, projectId, limit = 100 } = {}) {
      return [...memories.values()].filter((item) => item.ownerId === ownerId && item.status !== "deleted" && (!category || item.category === category) && (!scope || item.scope === scope) && (!projectId || item.projectId === projectId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(copy);
    },
    async updateMemory(id, ownerId, patch) {
      const current = memories.get(id); if (!current || current.ownerId !== ownerId || current.status === "deleted") return null;
      const updated = { ...current, ...copy(patch), id, ownerId, createdAt: current.createdAt, updatedAt: now(clock) };
      memories.set(id, updated); return copy(updated);
    },
    async deleteMemory(id, ownerId) {
      const current = memories.get(id); if (!current || current.ownerId !== ownerId) return false;
      memories.set(id, { ...current, status: "deleted", updatedAt: now(clock), deletedAt: now(clock) }); return true;
    },
    async retrieveMemories(ownerId, query, { projectId, limit = 6 } = {}) {
      return rankRelevantMemories([...memories.values()].filter((item) => item.ownerId === ownerId), query, { projectId, limit }).map(copy);
    }
  });
}
