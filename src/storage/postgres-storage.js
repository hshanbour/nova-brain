import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { SCHEMA_STATEMENTS } from "./schema.js";

const json = (value) => JSON.stringify(value ?? {});
const date = (value) => value instanceof Date ? value.toISOString() : value;
const ownerRow = (row) => row && ({ id: row.id, fullName: row.full_name, preferredName: row.preferred_name, arabicName: row.arabic_name, facts: row.facts, preferences: row.preferences, goals: row.goals, context: row.contextual_info, provenance: row.provenance, privacy: row.privacy, createdAt: date(row.created_at), updatedAt: date(row.updated_at) });
const conversationRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, title: row.title, createdAt: date(row.created_at), updatedAt: date(row.updated_at) });
const messageRow = (row) => row && ({ id: row.id, conversationId: row.conversation_id, ownerId: row.owner_id, role: row.role, content: row.content, sequence: Number(row.sequence), createdAt: date(row.created_at) });
const memoryRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, category: row.category, content: row.content, provenance: row.provenance, privacy: row.privacy, sensitivity: row.sensitivity, scope: row.scope, projectId: row.project_id, confidence: row.confidence === null ? null : Number(row.confidence), status: row.status, createdAt: date(row.created_at), updatedAt: date(row.updated_at), deletedAt: date(row.deleted_at) });

function queryTokens(value) { return new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []); }
function score(memory, query, projectId) {
  const matches = [...queryTokens(memory.content)].filter((token) => query.has(token)).length;
  return matches + (projectId && memory.projectId === projectId ? 4 : 0) + (["identity", "preference", "reusable_instruction"].includes(memory.category) ? 1 : 0);
}

export function createPostgresStorage({ connectionString }) {
  if (!connectionString) throw new Error("A Postgres connection string is required.");
  const sql = neon(connectionString); let initialization;
  const run = (statement, params = []) => sql.query(statement, params);

  const storage = {
    provider: "postgres",
    durable: true,
    async initialize({ owner, projects = [], memories = [] } = {}) {
      if (!initialization) initialization = (async () => {
        for (const statement of SCHEMA_STATEMENTS) await run(statement);
        if (owner) {
          await run(`INSERT INTO nova_owners (id, full_name, preferred_name, arabic_name, facts, preferences, goals, contextual_info, provenance, privacy)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10) ON CONFLICT (id) DO NOTHING`,
            [owner.id, owner.fullName, owner.preferredName, owner.arabicName, json(owner.facts), json(owner.preferences), JSON.stringify(owner.goals || []), json(owner.context), owner.provenance, owner.privacy]);
          for (const project of projects) await run(`INSERT INTO nova_projects (id, owner_id, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [project.id, owner.id, project.name, project.description]);
          for (const memory of memories) await run(`INSERT INTO nova_memories (id, owner_id, category, content, provenance, privacy, sensitivity, scope, project_id, confidence, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`, [memory.id, owner.id, memory.category, memory.content, memory.provenance, memory.privacy, memory.sensitivity, memory.scope, memory.projectId || null, memory.confidence ?? null, memory.status || "active"]);
        }
      })().catch((error) => { initialization = undefined; throw error; });
      return initialization;
    },
    async health() { await run("SELECT 1 AS ok"); return { provider: "postgres", durable: true, status: "ready" }; },
    async getOwner(ownerId) { return ownerRow((await run("SELECT * FROM nova_owners WHERE id=$1", [ownerId]))[0]); },
    async updateOwner(ownerId, patch) {
      const fields = { fullName: "full_name", preferredName: "preferred_name", arabicName: "arabic_name", facts: "facts", preferences: "preferences", goals: "goals", context: "contextual_info" };
      const entries = Object.entries(patch).filter(([key]) => fields[key]); if (!entries.length) return this.getOwner(ownerId);
      const params = [ownerId]; const sets = entries.map(([key, value], index) => { params.push(["facts","preferences","goals","context"].includes(key) ? JSON.stringify(value) : value); return `${fields[key]}=$${index + 2}${["facts","preferences","goals","context"].includes(key) ? "::jsonb" : ""}`; });
      return ownerRow((await run(`UPDATE nova_owners SET ${sets.join(",")}, updated_at=now() WHERE id=$1 RETURNING *`, params))[0]);
    },
    async ensureConversation({ id = randomUUID(), ownerId, title = null }) {
      const rows = await run(`INSERT INTO nova_conversations (id,owner_id,title) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id WHERE nova_conversations.owner_id=EXCLUDED.owner_id RETURNING *`, [id, ownerId, title]);
      return conversationRow(rows[0]);
    },
    async listConversations(ownerId, { limit = 20 } = {}) { return (await run("SELECT * FROM nova_conversations WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT $2", [ownerId, limit])).map(conversationRow); },
    async appendMessage({ conversationId, ownerId, role, content }) {
      const rows = await run(`INSERT INTO nova_messages (id,conversation_id,owner_id,role,content) SELECT $1,$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM nova_conversations WHERE id=$2 AND owner_id=$3) RETURNING *`, [randomUUID(), conversationId, ownerId, role, content]);
      if (!rows[0]) throw new Error("Conversation not found.");
      await run("UPDATE nova_conversations SET updated_at=now() WHERE id=$1 AND owner_id=$2", [conversationId, ownerId]); return messageRow(rows[0]);
    },
    async listMessages(conversationId, ownerId, { limit = 30 } = {}) {
      const rows = await run(`SELECT * FROM (SELECT * FROM nova_messages WHERE conversation_id=$1 AND owner_id=$2 ORDER BY sequence DESC LIMIT $3) recent ORDER BY sequence ASC`, [conversationId, ownerId, limit]); return rows.map(messageRow);
    },
    async createMemory(input) {
      const rows = await run(`INSERT INTO nova_memories (id,owner_id,category,content,provenance,privacy,sensitivity,scope,project_id,confidence,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [input.id || randomUUID(), input.ownerId, input.category, input.content, input.provenance, input.privacy, input.sensitivity, input.scope, input.projectId || null, input.confidence ?? null, input.status || "active"]); return memoryRow(rows[0]);
    },
    async getMemory(id, ownerId) { return memoryRow((await run("SELECT * FROM nova_memories WHERE id=$1 AND owner_id=$2 AND status<>'deleted'", [id, ownerId]))[0]); },
    async listMemories(ownerId, { category, scope, projectId, limit = 100 } = {}) {
      return (await run(`SELECT * FROM nova_memories WHERE owner_id=$1 AND status<>'deleted' AND ($2::text IS NULL OR category=$2) AND ($3::text IS NULL OR scope=$3) AND ($4::text IS NULL OR project_id=$4) ORDER BY updated_at DESC LIMIT $5`, [ownerId, category || null, scope || null, projectId || null, limit])).map(memoryRow);
    },
    async updateMemory(id, ownerId, patch) {
      const fields = { category:"category",content:"content",provenance:"provenance",privacy:"privacy",sensitivity:"sensitivity",scope:"scope",projectId:"project_id",confidence:"confidence",status:"status" };
      const entries = Object.entries(patch).filter(([key]) => fields[key]); if (!entries.length) return this.getMemory(id, ownerId);
      const params = [id, ownerId]; const sets = entries.map(([key,value],index) => { params.push(value); return `${fields[key]}=$${index+3}`; });
      return memoryRow((await run(`UPDATE nova_memories SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 AND status<>'deleted' RETURNING *`, params))[0]);
    },
    async deleteMemory(id, ownerId) { return (await run("UPDATE nova_memories SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2 AND status<>'deleted' RETURNING id", [id, ownerId])).length > 0; },
    async retrieveMemories(ownerId, queryText, { projectId, limit = 6, candidateLimit = 50 } = {}) {
      const candidates = (await run("SELECT * FROM nova_memories WHERE owner_id=$1 AND status='active' AND (project_id IS NULL OR project_id=$2 OR scope IN ('global','system')) ORDER BY updated_at DESC LIMIT $3", [ownerId, projectId || null, candidateLimit])).map(memoryRow);
      const query = queryTokens(queryText); return candidates.map((item) => ({ item, score: score(item, query, projectId) })).filter(({ score }) => score > 0).sort((a,b) => b.score-a.score || b.item.updatedAt.localeCompare(a.item.updatedAt)).slice(0,limit).map(({item}) => item);
    }
  };
  return Object.freeze(storage);
}
