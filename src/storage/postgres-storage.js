import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { SCHEMA_STATEMENTS } from "./schema.js";
import { rankRelevantMemories } from "../memory/relevance.js";

const json = (value) => JSON.stringify(value ?? {});
const date = (value) => value instanceof Date ? value.toISOString() : value;
const ownerRow = (row) => row && ({ id: row.id, fullName: row.full_name, preferredName: row.preferred_name, arabicName: row.arabic_name, facts: row.facts, preferences: row.preferences, goals: row.goals, context: row.contextual_info, provenance: row.provenance, privacy: row.privacy, createdAt: date(row.created_at), updatedAt: date(row.updated_at) });
const conversationRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, title: row.title, createdAt: date(row.created_at), updatedAt: date(row.updated_at) });
const messageRow = (row) => row && ({ id: row.id, conversationId: row.conversation_id, ownerId: row.owner_id, role: row.role, content: row.content, sequence: Number(row.sequence), createdAt: date(row.created_at) });
const memoryRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, category: row.category, content: row.content, provenance: row.provenance, privacy: row.privacy, sensitivity: row.sensitivity, scope: row.scope, projectId: row.project_id, confidence: row.confidence === null ? null : Number(row.confidence), status: row.status, createdAt: date(row.created_at), updatedAt: date(row.updated_at), deletedAt: date(row.deleted_at) });
const projectRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, name: row.name, description: row.description, createdAt: date(row.created_at), updatedAt: date(row.updated_at) });
const runRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, projectId: row.project_id, conversationId: row.conversation_id, goal: row.goal, status: row.status, currentStep: Number(row.current_step), result: row.result, error: row.error, createdAt: date(row.created_at), updatedAt: date(row.updated_at), completedAt: date(row.completed_at) });
const approvalRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, projectId: row.project_id, runId: row.run_id, tool: row.tool, reason: row.reason, riskLevel: row.risk_level, arguments: row.arguments, status: row.status, decision: row.decision, createdAt: date(row.created_at), decidedAt: date(row.decided_at) });
const activityRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, projectId: row.project_id, runId: row.run_id, action: row.action, tool: row.tool, status: row.status, summary: row.summary, metadata: row.metadata, sequence: Number(row.sequence), createdAt: date(row.created_at) });
const benchmarkSessionRow = (row) => row && ({ id: row.id, ownerId: row.owner_id, budgetUsd: Number(row.budget_usd), createdAt: date(row.created_at) });
const benchmarkResultRow = (row) => row && ({ id: row.id, sessionId: row.session_id, ownerId: row.owner_id, kind: row.kind, providerId: row.provider_id, sampleId: row.sample_id, label: row.label, status: row.status, estimatedCostUsd: Number(row.estimated_cost_usd), latencyMs: row.latency_ms === null ? null : Number(row.latency_ms), transcript: row.transcript, metrics: row.metrics, ratings: row.ratings, model: row.model, voice: row.voice, metadata: row.metadata, revealed: row.revealed, error: row.error, createdAt: date(row.created_at), updatedAt: date(row.updated_at) });

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
    async listProjects(ownerId) { return (await run("SELECT * FROM nova_projects WHERE owner_id=$1 ORDER BY name ASC, id ASC", [ownerId])).map(projectRow); },
    async ensureConversation({ id = randomUUID(), ownerId, title = null }) {
      const rows = await run(`INSERT INTO nova_conversations (id,owner_id,title) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id WHERE nova_conversations.owner_id=EXCLUDED.owner_id RETURNING *`, [id, ownerId, title]);
      return conversationRow(rows[0]);
    },
    async listConversations(ownerId, { limit = 20 } = {}) { return (await run("SELECT * FROM nova_conversations WHERE owner_id=$1 ORDER BY updated_at DESC, id ASC LIMIT $2", [ownerId, limit])).map(conversationRow); },
    async appendMessage({ conversationId, ownerId, role, content }) {
      const rows = await run(`INSERT INTO nova_messages (id,conversation_id,owner_id,role,content) SELECT $1,$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM nova_conversations WHERE id=$2 AND owner_id=$3) RETURNING *`, [randomUUID(), conversationId, ownerId, role, content]);
      if (!rows[0]) throw new Error("Conversation not found.");
      await run("UPDATE nova_conversations SET updated_at=now() WHERE id=$1 AND owner_id=$2", [conversationId, ownerId]); return messageRow(rows[0]);
    },
    async listMessages(conversationId, ownerId, { limit = 30, offset = 0 } = {}) {
      const rows = await run(`SELECT * FROM (SELECT * FROM nova_messages WHERE conversation_id=$1 AND owner_id=$2 ORDER BY sequence DESC LIMIT $3 OFFSET $4) recent ORDER BY sequence ASC`, [conversationId, ownerId, limit, offset]); return rows.map(messageRow);
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
      const candidates = (await run("SELECT * FROM nova_memories WHERE owner_id=$1 AND status='active' ORDER BY updated_at DESC, id ASC LIMIT $2", [ownerId, candidateLimit])).map(memoryRow);
      return rankRelevantMemories(candidates, queryText, { projectId, limit });
    },
    async createRun({ id = randomUUID(), ownerId, projectId = null, conversationId = null, goal, status = "planning" }) { return runRow((await run("INSERT INTO nova_execution_runs (id,owner_id,project_id,conversation_id,goal,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [id,ownerId,projectId,conversationId,goal,status]))[0]); },
    async updateRun(id, ownerId, patch) {
      const fields={status:"status",currentStep:"current_step",result:"result",error:"error",completedAt:"completed_at"}; const entries=Object.entries(patch).filter(([key])=>fields[key]); if(!entries.length)return null;
      const params=[id,ownerId]; const sets=entries.map(([key,value],index)=>{params.push(key==="result"?JSON.stringify(value):value);return `${fields[key]}=$${index+3}${key==="result"?"::jsonb":""}`;});
      return runRow((await run(`UPDATE nova_execution_runs SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,params))[0]);
    },
    async listRuns(ownerId,{projectId,limit=50}={}){return(await run("SELECT * FROM nova_execution_runs WHERE owner_id=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY updated_at DESC,id ASC LIMIT $3",[ownerId,projectId||null,limit])).map(runRow);},
    async createApproval(input){return approvalRow((await run("INSERT INTO nova_approvals (id,owner_id,project_id,run_id,tool,reason,risk_level,arguments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *",[input.id||randomUUID(),input.ownerId,input.projectId||null,input.runId||null,input.tool,input.reason,input.riskLevel,JSON.stringify(input.arguments||{})]))[0]);},
    async getApproval(id,ownerId){return approvalRow((await run("SELECT * FROM nova_approvals WHERE id=$1 AND owner_id=$2",[id,ownerId]))[0]);},
    async decideApproval(id,ownerId,decision){return approvalRow((await run("UPDATE nova_approvals SET status=$3,decision=$3,decided_at=now() WHERE id=$1 AND owner_id=$2 AND status='pending' RETURNING *",[id,ownerId,decision]))[0]);},
    async listApprovals(ownerId,{status,limit=50}={}){return(await run("SELECT * FROM nova_approvals WHERE owner_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,id ASC LIMIT $3",[ownerId,status||null,limit])).map(approvalRow);},
    async appendActivity(input){return activityRow((await run("INSERT INTO nova_activity_events (id,owner_id,project_id,run_id,action,tool,status,summary,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *",[input.id||randomUUID(),input.ownerId,input.projectId||null,input.runId||null,input.action,input.tool||null,input.status,input.summary,JSON.stringify(input.metadata||{})]))[0]);},
    async listActivity(ownerId,{projectId,runId,limit=100}={}){return(await run("SELECT * FROM nova_activity_events WHERE owner_id=$1 AND ($2::text IS NULL OR project_id=$2) AND ($3::text IS NULL OR run_id=$3) ORDER BY sequence DESC LIMIT $4",[ownerId,projectId||null,runId||null,limit])).map(activityRow);},
    async createVoiceBenchmarkSession(input){return benchmarkSessionRow((await run("INSERT INTO nova_voice_benchmark_sessions (id,owner_id,budget_usd,created_at) VALUES ($1,$2,$3,$4) RETURNING *",[input.id||randomUUID(),input.ownerId,input.budgetUsd,input.createdAt||new Date().toISOString()]))[0]);},
    async getVoiceBenchmarkSession(id,ownerId){return benchmarkSessionRow((await run("SELECT * FROM nova_voice_benchmark_sessions WHERE id=$1 AND owner_id=$2",[id,ownerId]))[0]);},
    async createVoiceBenchmarkResult(input){return benchmarkResultRow((await run(`INSERT INTO nova_voice_benchmark_results (id,session_id,owner_id,kind,provider_id,sample_id,label,status,estimated_cost_usd,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,[input.id||randomUUID(),input.sessionId,input.ownerId,input.kind,input.providerId,input.sampleId,input.label,input.status,input.estimatedCostUsd||0,JSON.stringify(input.metadata||{})]))[0]);},
    async reserveVoiceBenchmarkResult(input,budgetUsd){
      const estimate=Number(input.estimatedCostUsd||0);
      const reserved=(await run(`INSERT INTO nova_voice_benchmark_budgets (owner_id,reserved_usd,cap_usd) VALUES ($1,$2,$3) ON CONFLICT (owner_id) DO UPDATE SET reserved_usd=nova_voice_benchmark_budgets.reserved_usd+EXCLUDED.reserved_usd,cap_usd=LEAST(nova_voice_benchmark_budgets.cap_usd,EXCLUDED.cap_usd),updated_at=now() WHERE nova_voice_benchmark_budgets.reserved_usd+EXCLUDED.reserved_usd<=LEAST(nova_voice_benchmark_budgets.cap_usd,EXCLUDED.cap_usd) RETURNING reserved_usd`,[input.ownerId,estimate,budgetUsd]))[0];
      if(!reserved)return null;
      return benchmarkResultRow((await run(`INSERT INTO nova_voice_benchmark_results (id,session_id,owner_id,kind,provider_id,sample_id,label,status,estimated_cost_usd,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,[input.id||randomUUID(),input.sessionId,input.ownerId,input.kind,input.providerId,input.sampleId,input.label,input.status,estimate,JSON.stringify(input.metadata||{})]))[0]);
    },
    async updateVoiceBenchmarkResult(id,ownerId,patch){const fields={status:"status",latencyMs:"latency_ms",transcript:"transcript",metrics:"metrics",ratings:"ratings",model:"model",voice:"voice",revealed:"revealed",error:"error"};const entries=Object.entries(patch).filter(([key])=>fields[key]);if(!entries.length)return benchmarkResultRow((await run("SELECT * FROM nova_voice_benchmark_results WHERE id=$1 AND owner_id=$2",[id,ownerId]))[0]);const params=[id,ownerId];const sets=entries.map(([key,value],index)=>{params.push(["metrics","ratings"].includes(key)?JSON.stringify(value):value);return `${fields[key]}=$${index+3}${["metrics","ratings"].includes(key)?"::jsonb":""}`;});return benchmarkResultRow((await run(`UPDATE nova_voice_benchmark_results SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,params))[0]);},
    async listVoiceBenchmarkResults(sessionId,ownerId){return(await run("SELECT * FROM nova_voice_benchmark_results WHERE session_id=$1 AND owner_id=$2 ORDER BY created_at ASC,id ASC",[sessionId,ownerId])).map(benchmarkResultRow);},
    async sumVoiceBenchmarkCost(ownerId){return Number((await run("SELECT COALESCE((SELECT reserved_usd FROM nova_voice_benchmark_budgets WHERE owner_id=$1),(SELECT COALESCE(SUM(estimated_cost_usd),0) FROM nova_voice_benchmark_results WHERE owner_id=$1),0) AS total",[ownerId]))[0]?.total||0);}
  };
  return Object.freeze(storage);
}

