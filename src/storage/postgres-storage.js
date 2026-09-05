import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { SCHEMA_STATEMENTS } from "./schema.js";
import { rankRelevantMemories } from "../memory/relevance.js";

const json = (value) => JSON.stringify(value ?? {});
const date = (value) => (value instanceof Date ? value.toISOString() : value);
const ownerRow = (row) =>
  row && {
    id: row.id,
    fullName: row.full_name,
    preferredName: row.preferred_name,
    arabicName: row.arabic_name,
    facts: row.facts,
    preferences: row.preferences,
    goals: row.goals,
    context: row.contextual_info,
    provenance: row.provenance,
    privacy: row.privacy,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
const conversationRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
const messageRow = (row) =>
  row && {
    id: row.id,
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    role: row.role,
    content: row.content,
    sequence: Number(row.sequence),
    createdAt: date(row.created_at),
  };
const memoryRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    category: row.category,
    content: row.content,
    provenance: row.provenance,
    privacy: row.privacy,
    sensitivity: row.sensitivity,
    scope: row.scope,
    projectId: row.project_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    status: row.status,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    deletedAt: date(row.deleted_at),
  };
const speakerProfileRow = (row, includeRepresentation = false) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    displayName: row.display_name,
    relation: row.relation,
    scope: row.scope,
    enrollmentStatus: row.enrollment_status,
    status: row.status,
    representationVersion: row.representation_version,
    consentAt: date(row.consent_at),
    consentActor: row.consent_actor,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    revokedAt: date(row.revoked_at),
    ...(includeRepresentation ? { representation: row.representation } : {}),
  };
const anonymousSpeakerRow = (row, includeRepresentation = false) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    stableLabel: row.stable_label,
    status: row.status,
    representationVersion: row.representation_version,
    consentAt: date(row.consent_at),
    consentActor: row.consent_actor,
    selfReportedName: row.self_reported_name,
    firstSeenAt: date(row.first_seen_at),
    lastSeenAt: date(row.last_seen_at),
    encounterCount: Number(row.encounter_count),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    deletedAt: date(row.deleted_at),
    ...(includeRepresentation ? { representation: row.representation } : {}),
  };
const voiceUtteranceRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    speakerProfileId: row.speaker_profile_id,
    speakerLabel: row.speaker_label,
    confidence: row.confidence === null ? null : Number(row.confidence),
    text: row.text,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    createdAt: date(row.created_at),
  };
const projectRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
const runRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    goal: row.goal,
    status: row.status,
    currentStep: Number(row.current_step),
    result: row.result,
    error: row.error,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    completedAt: date(row.completed_at),
  };
const autonomyTaskRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    title: row.title,
    objective: row.objective,
    taskType: row.task_type,
    status: row.status,
    priority: Number(row.priority),
    currentPhase: row.current_phase,
    currentStep: Number(row.current_step),
    maxSteps: Number(row.max_steps),
    maxRetries: Number(row.max_retries),
    maxRuntimeMinutes: Number(row.max_runtime_minutes),
    branch: row.branch,
    startingCommit: row.starting_commit,
    currentCommit: row.current_commit,
    checkpoint: row.checkpoint,
    approvalState: row.approval_state,
    blockedReason: row.blocked_reason,
    resultSummary: row.result_summary,
    errorCode: row.error_code,
    nextRunAt: date(row.next_run_at),
    metadata: row.metadata,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: date(row.lease_expires_at),
    retryCount: Number(row.retry_count),
    repairIteration: Number(row.repair_iteration),
    createdAt: date(row.created_at),
    startedAt: date(row.started_at),
    updatedAt: date(row.updated_at),
    completedAt: date(row.completed_at),
  };
const autonomyStepRow = (row) =>
  row && {
    taskId: row.task_id,
    stepId: row.step_id,
    stepType: row.step_type,
    capability: row.capability,
    operationFingerprint: row.operation_fingerprint,
    status: row.status,
    attempt: Number(row.attempt),
    input: row.input,
    result: row.result,
    errorCode: row.error_code,
    startedAt: date(row.started_at),
    completedAt: date(row.completed_at),
    createdAt: date(row.created_at),
  };
const approvalRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    runId: row.run_id,
    tool: row.tool,
    reason: row.reason,
    riskLevel: row.risk_level,
    arguments: row.arguments,
    status: row.status,
    decision: row.decision,
    createdAt: date(row.created_at),
    decidedAt: date(row.decided_at),
  };
const activityRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    runId: row.run_id,
    action: row.action,
    tool: row.tool,
    status: row.status,
    summary: row.summary,
    metadata: row.metadata,
    sequence: Number(row.sequence),
    createdAt: date(row.created_at),
  };
const benchmarkSessionRow = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    budgetUsd: Number(row.budget_usd),
    createdAt: date(row.created_at),
  };
const benchmarkResultRow = (row) =>
  row && {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    kind: row.kind,
    providerId: row.provider_id,
    sampleId: row.sample_id,
    label: row.label,
    status: row.status,
    estimatedCostUsd: Number(row.estimated_cost_usd),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    transcript: row.transcript,
    metrics: row.metrics,
    ratings: row.ratings,
    model: row.model,
    voice: row.voice,
    metadata: row.metadata,
    revealed: row.revealed,
    error: row.error,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };

export function createPostgresStorage({ connectionString }) {
  if (!connectionString)
    throw new Error("A Postgres connection string is required.");
  const sql = neon(connectionString);
  let initialization;
  const run = (statement, params = []) => sql.query(statement, params);

  const storage = {
    provider: "postgres",
    durable: true,
    async initialize({ owner, projects = [], memories = [] } = {}) {
      if (!initialization)
        initialization = (async () => {
          for (const statement of SCHEMA_STATEMENTS) await run(statement);
          if (owner) {
            await run(
              `INSERT INTO nova_owners (id, full_name, preferred_name, arabic_name, facts, preferences, goals, contextual_info, provenance, privacy)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10) ON CONFLICT (id) DO NOTHING`,
              [
                owner.id,
                owner.fullName,
                owner.preferredName,
                owner.arabicName,
                json(owner.facts),
                json(owner.preferences),
                JSON.stringify(owner.goals || []),
                json(owner.context),
                owner.provenance,
                owner.privacy,
              ],
            );
            for (const project of projects)
              await run(
                `INSERT INTO nova_projects (id, owner_id, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
                [project.id, owner.id, project.name, project.description],
              );
            for (const memory of memories)
              await run(
                `INSERT INTO nova_memories (id, owner_id, category, content, provenance, privacy, sensitivity, scope, project_id, confidence, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET content=CASE WHEN EXCLUDED.provenance='system-generated-project-release' THEN EXCLUDED.content ELSE nova_memories.content END,updated_at=CASE WHEN EXCLUDED.provenance='system-generated-project-release' AND nova_memories.content<>EXCLUDED.content THEN now() ELSE nova_memories.updated_at END`,
                [
                  memory.id,
                  owner.id,
                  memory.category,
                  memory.content,
                  memory.provenance,
                  memory.privacy,
                  memory.sensitivity,
                  memory.scope,
                  memory.projectId || null,
                  memory.confidence ?? null,
                  memory.status || "active",
                ],
              );
          }
        })().catch((error) => {
          initialization = undefined;
          throw error;
        });
      return initialization;
    },
    async health() {
      await run("SELECT 1 AS ok");
      return { provider: "postgres", durable: true, status: "ready" };
    },
    async getOwner(ownerId) {
      return ownerRow(
        (await run("SELECT * FROM nova_owners WHERE id=$1", [ownerId]))[0],
      );
    },
    async updateOwner(ownerId, patch) {
      const fields = {
        fullName: "full_name",
        preferredName: "preferred_name",
        arabicName: "arabic_name",
        facts: "facts",
        preferences: "preferences",
        goals: "goals",
        context: "contextual_info",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      if (!entries.length) return this.getOwner(ownerId);
      const params = [ownerId];
      const sets = entries.map(([key, value], index) => {
        params.push(
          ["facts", "preferences", "goals", "context"].includes(key)
            ? JSON.stringify(value)
            : value,
        );
        return `${fields[key]}=$${index + 2}${["facts", "preferences", "goals", "context"].includes(key) ? "::jsonb" : ""}`;
      });
      return ownerRow(
        (
          await run(
            `UPDATE nova_owners SET ${sets.join(",")}, updated_at=now() WHERE id=$1 RETURNING *`,
            params,
          )
        )[0],
      );
    },
    async listProjects(ownerId) {
      return (
        await run(
          "SELECT * FROM nova_projects WHERE owner_id=$1 ORDER BY name ASC, id ASC",
          [ownerId],
        )
      ).map(projectRow);
    },
    async ensureConversation({ id = randomUUID(), ownerId, title = null }) {
      const rows = await run(
        `INSERT INTO nova_conversations (id,owner_id,title) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id WHERE nova_conversations.owner_id=EXCLUDED.owner_id RETURNING *`,
        [id, ownerId, title],
      );
      return conversationRow(rows[0]);
    },
    async listConversations(ownerId, { limit = 20 } = {}) {
      return (
        await run(
          "SELECT * FROM nova_conversations WHERE owner_id=$1 ORDER BY updated_at DESC, id ASC LIMIT $2",
          [ownerId, limit],
        )
      ).map(conversationRow);
    },
    async appendMessage({ conversationId, ownerId, role, content }) {
      const rows = await run(
        `INSERT INTO nova_messages (id,conversation_id,owner_id,role,content) SELECT $1,$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM nova_conversations WHERE id=$2 AND owner_id=$3) RETURNING *`,
        [randomUUID(), conversationId, ownerId, role, content],
      );
      if (!rows[0]) throw new Error("Conversation not found.");
      await run(
        "UPDATE nova_conversations SET updated_at=now() WHERE id=$1 AND owner_id=$2",
        [conversationId, ownerId],
      );
      return messageRow(rows[0]);
    },
    async listMessages(
      conversationId,
      ownerId,
      { limit = 30, offset = 0 } = {},
    ) {
      const rows = await run(
        `SELECT * FROM (SELECT * FROM nova_messages WHERE conversation_id=$1 AND owner_id=$2 ORDER BY sequence DESC LIMIT $3 OFFSET $4) recent ORDER BY sequence ASC`,
        [conversationId, ownerId, limit, offset],
      );
      return rows.map(messageRow);
    },
    async createMemory(input) {
      const rows = await run(
        `INSERT INTO nova_memories (id,owner_id,category,content,provenance,privacy,sensitivity,scope,project_id,confidence,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          input.id || randomUUID(),
          input.ownerId,
          input.category,
          input.content,
          input.provenance,
          input.privacy,
          input.sensitivity,
          input.scope,
          input.projectId || null,
          input.confidence ?? null,
          input.status || "active",
        ],
      );
      return memoryRow(rows[0]);
    },
    async getMemory(id, ownerId) {
      return memoryRow(
        (
          await run(
            "SELECT * FROM nova_memories WHERE id=$1 AND owner_id=$2 AND status<>'deleted'",
            [id, ownerId],
          )
        )[0],
      );
    },
    async listMemories(
      ownerId,
      { category, scope, projectId, limit = 100 } = {},
    ) {
      return (
        await run(
          `SELECT * FROM nova_memories WHERE owner_id=$1 AND status<>'deleted' AND ($2::text IS NULL OR category=$2) AND ($3::text IS NULL OR scope=$3) AND ($4::text IS NULL OR project_id=$4) ORDER BY updated_at DESC LIMIT $5`,
          [ownerId, category || null, scope || null, projectId || null, limit],
        )
      ).map(memoryRow);
    },
    async updateMemory(id, ownerId, patch) {
      const fields = {
        category: "category",
        content: "content",
        provenance: "provenance",
        privacy: "privacy",
        sensitivity: "sensitivity",
        scope: "scope",
        projectId: "project_id",
        confidence: "confidence",
        status: "status",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      if (!entries.length) return this.getMemory(id, ownerId);
      const params = [id, ownerId];
      const sets = entries.map(([key, value], index) => {
        params.push(value);
        return `${fields[key]}=$${index + 3}`;
      });
      return memoryRow(
        (
          await run(
            `UPDATE nova_memories SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 AND status<>'deleted' RETURNING *`,
            params,
          )
        )[0],
      );
    },
    async deleteMemory(id, ownerId) {
      return (
        (
          await run(
            "UPDATE nova_memories SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2 AND status<>'deleted' RETURNING id",
            [id, ownerId],
          )
        ).length > 0
      );
    },
    async retrieveMemories(
      ownerId,
      queryText,
      { projectId, limit = 6, candidateLimit = 50 } = {},
    ) {
      const candidates = (
        await run(
          "SELECT * FROM nova_memories WHERE owner_id=$1 AND status='active' ORDER BY updated_at DESC, id ASC LIMIT $2",
          [ownerId, candidateLimit],
        )
      ).map(memoryRow);
      return rankRelevantMemories(candidates, queryText, { projectId, limit });
    },
    async createSpeakerProfile(input) {
      return speakerProfileRow(
        (
          await run(
            `INSERT INTO nova_speaker_profiles (id,owner_id,display_name,relation,scope,enrollment_status,status,representation,representation_version,consent_at,consent_actor,enrollment_attempt_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT (owner_id,enrollment_attempt_id) WHERE enrollment_attempt_id IS NOT NULL DO UPDATE SET updated_at=nova_speaker_profiles.updated_at RETURNING *`,
            [
              input.id || randomUUID(),
              input.ownerId,
              input.displayName,
              input.relation,
              input.scope,
              input.enrollmentStatus,
              input.status,
              JSON.stringify(input.representation),
              input.representationVersion,
              input.consentAt,
              input.consentActor,
              input.enrollmentAttemptId || null,
            ],
          )
        )[0],
        true,
      );
    },
    async getSpeakerProfileByEnrollmentAttempt(ownerId, enrollmentAttemptId) {
      return speakerProfileRow(
        (
          await run(
            "SELECT * FROM nova_speaker_profiles WHERE owner_id=$1 AND enrollment_attempt_id=$2",
            [ownerId, enrollmentAttemptId],
          )
        )[0],
        true,
      );
    },
    async listSpeakerProfiles(ownerId, { includeRepresentation = false } = {}) {
      return (
        await run(
          "SELECT * FROM nova_speaker_profiles WHERE owner_id=$1 ORDER BY created_at ASC,id ASC",
          [ownerId],
        )
      ).map((row) => speakerProfileRow(row, includeRepresentation));
    },
    async updateSpeakerProfile(id, ownerId, patch) {
      const fields = {
        displayName: "display_name",
        relation: "relation",
        enrollmentStatus: "enrollment_status",
        status: "status",
        representation: "representation",
        revokedAt: "revoked_at",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      if (!entries.length)
        return speakerProfileRow(
          (
            await run(
              "SELECT * FROM nova_speaker_profiles WHERE id=$1 AND owner_id=$2",
              [id, ownerId],
            )
          )[0],
          true,
        );
      const params = [id, ownerId];
      const sets = entries.map(([key, value], index) => {
        params.push(key === "representation" ? JSON.stringify(value) : value);
        return `${fields[key]}=$${index + 3}${key === "representation" ? "::jsonb" : ""}`;
      });
      return speakerProfileRow(
        (
          await run(
            `UPDATE nova_speaker_profiles SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
            params,
          )
        )[0],
        true,
      );
    },
    async deleteSpeakerProfile(id, ownerId) {
      return (
        (
          await run(
            "DELETE FROM nova_speaker_profiles WHERE id=$1 AND owner_id=$2 RETURNING id",
            [id, ownerId],
          )
        ).length > 0
      );
    },
    async createAnonymousSpeakerProfile(input) {
      return anonymousSpeakerRow(
        (
          await run(
            `INSERT INTO nova_anonymous_speaker_profiles (id,owner_id,stable_label,representation,representation_version,status,consent_at,consent_actor,self_reported_name,first_seen_at,last_seen_at,encounter_count) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              input.id || randomUUID(),
              input.ownerId,
              input.stableLabel,
              JSON.stringify(input.representation),
              input.representationVersion,
              input.status || "active",
              input.consentAt,
              input.consentActor,
              input.selfReportedName || null,
              input.firstSeenAt,
              input.lastSeenAt,
              input.encounterCount || 1,
            ],
          )
        )[0],
        true,
      );
    },
    async listAnonymousSpeakerProfiles(
      ownerId,
      { includeRepresentation = false } = {},
    ) {
      return (
        await run(
          "SELECT * FROM nova_anonymous_speaker_profiles WHERE owner_id=$1 AND status<>'deleted' ORDER BY first_seen_at ASC,id ASC",
          [ownerId],
        )
      ).map((row) => anonymousSpeakerRow(row, includeRepresentation));
    },
    async updateAnonymousSpeakerProfile(id, ownerId, patch) {
      const fields = {
        representation: "representation",
        lastSeenAt: "last_seen_at",
        encounterCount: "encounter_count",
        selfReportedName: "self_reported_name",
        status: "status",
        deletedAt: "deleted_at",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      if (!entries.length)
        return anonymousSpeakerRow(
          (
            await run(
              "SELECT * FROM nova_anonymous_speaker_profiles WHERE id=$1 AND owner_id=$2 AND status<>'deleted'",
              [id, ownerId],
            )
          )[0],
          true,
        );
      const params = [id, ownerId];
      const sets = entries.map(([key, value], index) => {
        params.push(key === "representation" ? JSON.stringify(value) : value);
        return `${fields[key]}=$${index + 3}${key === "representation" ? "::jsonb" : ""}`;
      });
      return anonymousSpeakerRow(
        (
          await run(
            `UPDATE nova_anonymous_speaker_profiles SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 AND status<>'deleted' RETURNING *`,
            params,
          )
        )[0],
        true,
      );
    },
    async deleteAnonymousSpeakerProfile(id, ownerId) {
      return (
        (
          await run(
            "UPDATE nova_anonymous_speaker_profiles SET status='deleted',representation=NULL,deleted_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2 AND status<>'deleted' RETURNING id",
            [id, ownerId],
          )
        ).length > 0
      );
    },
    async purgeInvalidOwnerSpeakerEnrollment(ownerId) {
      const rows = await run(
        `WITH target AS (SELECT id FROM nova_speaker_profiles WHERE owner_id=$1 AND relation='owner'), scrub AS (UPDATE nova_voice_utterances SET speaker_profile_id=NULL,speaker_label='unknown',confidence=NULL WHERE owner_id=$1 AND (speaker_profile_id IN (SELECT id FROM target) OR speaker_label='owner') RETURNING id), audits AS (DELETE FROM nova_activity_events WHERE owner_id=$1 AND (action LIKE 'speaker_%' OR metadata ? 'speakerProfileId') RETURNING id), profiles AS (DELETE FROM nova_speaker_profiles WHERE id IN (SELECT id FROM target) RETURNING id,representation) SELECT (SELECT count(*) FROM profiles)::int AS profiles_deleted,(SELECT count(*) FROM profiles WHERE representation IS NOT NULL)::int AS voiceprints_deleted,(SELECT count(*) FROM scrub)::int AS utterances_scrubbed,(SELECT count(*) FROM audits)::int AS audit_references_deleted`,
        [ownerId],
      );
      const row = rows[0] || {};
      return {
        profilesDeleted: row.profiles_deleted || 0,
        voiceprintsDeleted: row.voiceprints_deleted || 0,
        utterancesScrubbed: row.utterances_scrubbed || 0,
        auditReferencesDeleted: row.audit_references_deleted || 0,
      };
    },
    async speakerPrivacyStatus(ownerId) {
      const row =
        (
          await run(
            `SELECT (SELECT count(*) FROM nova_speaker_profiles WHERE owner_id=$1 AND relation='owner')::int AS owner_profiles,(SELECT count(*) FROM nova_speaker_profiles WHERE owner_id=$1 AND relation='owner' AND representation IS NOT NULL)::int AS encrypted_voiceprints,(SELECT count(*) FROM nova_voice_utterances WHERE owner_id=$1 AND (speaker_label='owner' OR speaker_profile_id IN (SELECT id FROM nova_speaker_profiles WHERE owner_id=$1 AND relation='owner')))::int AS linked_utterances,(SELECT count(*) FROM nova_activity_events WHERE owner_id=$1 AND (action LIKE 'speaker_%' OR metadata ? 'speakerProfileId'))::int AS identifying_audit_references`,
            [ownerId],
          )
        )[0] || {};
      return {
        ownerProfiles: row.owner_profiles || 0,
        encryptedVoiceprints: row.encrypted_voiceprints || 0,
        linkedUtterances: row.linked_utterances || 0,
        identifyingAuditReferences: row.identifying_audit_references || 0,
        rawAudioObjects: 0,
      };
    },
    async createVoiceUtterance(input) {
      return voiceUtteranceRow(
        (
          await run(
            `INSERT INTO nova_voice_utterances (id,owner_id,conversation_id,speaker_profile_id,speaker_label,confidence,text,started_at_ms,ended_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              input.id || randomUUID(),
              input.ownerId,
              input.conversationId,
              input.speakerProfileId || null,
              input.speakerLabel,
              input.confidence,
              input.text,
              input.startedAtMs,
              input.endedAtMs,
            ],
          )
        )[0],
      );
    },
    async listVoiceUtterances(conversationId, ownerId, { limit = 100 } = {}) {
      return (
        await run(
          "SELECT * FROM nova_voice_utterances WHERE conversation_id=$1 AND owner_id=$2 ORDER BY created_at ASC,id ASC LIMIT $3",
          [conversationId, ownerId, limit],
        )
      ).map(voiceUtteranceRow);
    },
    async createRun({
      id = randomUUID(),
      ownerId,
      projectId = null,
      conversationId = null,
      goal,
      status = "planning",
    }) {
      return runRow(
        (
          await run(
            "INSERT INTO nova_execution_runs (id,owner_id,project_id,conversation_id,goal,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
            [id, ownerId, projectId, conversationId, goal, status],
          )
        )[0],
      );
    },
    async updateRun(id, ownerId, patch) {
      const fields = {
        status: "status",
        currentStep: "current_step",
        result: "result",
        error: "error",
        completedAt: "completed_at",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      if (!entries.length) return null;
      const params = [id, ownerId];
      const sets = entries.map(([key, value], index) => {
        params.push(key === "result" ? JSON.stringify(value) : value);
        return `${fields[key]}=$${index + 3}${key === "result" ? "::jsonb" : ""}`;
      });
      return runRow(
        (
          await run(
            `UPDATE nova_execution_runs SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
            params,
          )
        )[0],
      );
    },
    async listRuns(ownerId, { projectId, limit = 50 } = {}) {
      return (
        await run(
          "SELECT * FROM nova_execution_runs WHERE owner_id=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY updated_at DESC,id ASC LIMIT $3",
          [ownerId, projectId || null, limit],
        )
      ).map(runRow);
    },
    async createAutonomyTask(input) {
      return autonomyTaskRow(
        (
          await run(
            `INSERT INTO nova_autonomy_tasks (id,owner_id,project_id,title,objective,task_type,status,priority,current_phase,current_step,max_steps,max_retries,max_runtime_minutes,branch,starting_commit,current_commit,checkpoint,next_run_at,metadata,retry_count,repair_iteration) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,'queued',0,$8,$9,$10,$11,$12,$12,$13::jsonb,COALESCE($14::timestamptz,now()),$15::jsonb,0,0) RETURNING *`,
            [
              input.id || randomUUID(),
              input.ownerId,
              input.projectId || null,
              input.title,
              input.objective,
              input.taskType || "developer",
              input.priority || 0,
              input.maxSteps || 30,
              input.maxRetries ?? 3,
              input.maxRuntimeMinutes || 30,
              input.branch || null,
              input.startingCommit || null,
              JSON.stringify({
                completedSteps: [],
                pendingStep: null,
                findings: [],
              }),
              input.nextRunAt || null,
              JSON.stringify(input.metadata || {}),
            ],
          )
        )[0],
      );
    },
    async getAutonomyTask(id, ownerId) {
      return autonomyTaskRow(
        (
          await run(
            "SELECT * FROM nova_autonomy_tasks WHERE id=$1 AND owner_id=$2",
            [id, ownerId],
          )
        )[0],
      );
    },
    async listAutonomyTasks(ownerId, { status, limit = 50 } = {}) {
      return (
        await run(
          "SELECT * FROM nova_autonomy_tasks WHERE owner_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY priority DESC,created_at ASC LIMIT $3",
          [ownerId, status || null, limit],
        )
      ).map(autonomyTaskRow);
    },
    async updateAutonomyTask(id, ownerId, patch) {
      const fields = {
        status: "status",
        currentPhase: "current_phase",
        currentStep: "current_step",
        currentCommit: "current_commit",
        checkpoint: "checkpoint",
        approvalState: "approval_state",
        blockedReason: "blocked_reason",
        resultSummary: "result_summary",
        errorCode: "error_code",
        nextRunAt: "next_run_at",
        metadata: "metadata",
        leaseOwner: "lease_owner",
        leaseToken: "lease_token",
        leaseExpiresAt: "lease_expires_at",
        retryCount: "retry_count",
        repairIteration: "repair_iteration",
        startedAt: "started_at",
        completedAt: "completed_at",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      if (!entries.length) return this.getAutonomyTask(id, ownerId);
      const params = [id, ownerId];
      const sets = entries.map(([key, value], i) => {
        params.push(
          ["checkpoint", "approvalState", "metadata"].includes(key)
            ? JSON.stringify(value)
            : value,
        );
        return `${fields[key]}=$${i + 3}${["checkpoint", "approvalState", "metadata"].includes(key) ? "::jsonb" : ""}`;
      });
      return autonomyTaskRow(
        (
          await run(
            `UPDATE nova_autonomy_tasks SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
            params,
          )
        )[0],
      );
    },
    async migrateAutonomyTask(input) {
      const metadata = JSON.stringify({
          steps: input.plan,
          migrationPlanVersion: input.planVersion,
          requiredCapability: "repo_mutate_local",
        }),
        audit = JSON.stringify({
          taskId: input.taskId,
          migrationType: "repair_worker_runtime_v1_continuation",
          oldCommit: input.expectedCommit,
          newCommit: input.targetCommit,
          oldRuntimeMinutes: input.oldRuntimeMinutes,
          newRuntimeMinutes: input.runtimeMinutes,
          oldPlanVersion: input.oldPlanVersion,
          newPlanVersion: input.planVersion,
          actorType: input.actorType,
          result: "completed",
        });
      const rows = await run(
        `WITH updated AS (UPDATE nova_autonomy_tasks SET status='queued',starting_commit=$6,current_commit=$6,max_steps=GREATEST(max_steps,$7),max_runtime_minutes=$8,started_at=now(),completed_at=NULL,next_run_at=now(),blocked_reason=NULL,error_code=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,metadata=metadata||$9::jsonb,updated_at=now() WHERE id=$1 AND owner_id=$2 AND branch=$3 AND current_commit=$4 AND updated_at=$5::timestamptz AND (lease_token IS NULL OR lease_expires_at<=now()) RETURNING *), audited AS (INSERT INTO nova_activity_events (id,owner_id,project_id,run_id,action,status,summary,metadata) SELECT gen_random_uuid(),owner_id,project_id,id,'autonomy_task_migrated','completed','Repaired an allowlisted Worker task continuation.',$10::jsonb FROM updated RETURNING id) SELECT * FROM updated`,
        [
          input.taskId,
          input.ownerId,
          input.expectedBranch,
          input.expectedCommit,
          input.expectedUpdatedAt,
          input.targetCommit,
          input.plan.length + 2,
          input.runtimeMinutes,
          metadata,
          audit,
        ],
      );
      return autonomyTaskRow(rows[0]);
    },
    async claimAutonomyTask({
      ownerId,
      workerId,
      capabilities,
      leaseMs = 30000,
      idempotencyKey,
    }) {
      const row = (
        await run(
          `WITH expired AS (UPDATE nova_autonomy_tasks SET status='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE owner_id=$1 AND lease_expires_at<=now() AND status IN ('running','planning','retrying')), candidate AS (SELECT id FROM nova_autonomy_tasks WHERE owner_id=$1 AND ((status IN ('queued','retrying') AND COALESCE(next_run_at,now())<=now()) OR (status='waiting' AND next_run_at IS NOT NULL AND next_run_at<=now())) AND (metadata->>'requiredCapability' IS NULL OR metadata->>'requiredCapability'=ANY($2::text[])) ORDER BY priority DESC,created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE nova_autonomy_tasks t SET status=CASE WHEN started_at IS NULL THEN 'planning' ELSE 'running' END,started_at=COALESCE(started_at,now()),lease_owner=$3,lease_token=$4,lease_expires_at=now()+($5::int*interval '1 millisecond'),metadata=metadata||jsonb_build_object('claimKey',$6::text),updated_at=now() FROM candidate WHERE t.id=candidate.id RETURNING t.*`,
          [
            ownerId,
            capabilities,
            workerId,
            randomUUID(),
            leaseMs,
            idempotencyKey,
          ],
        )
      )[0];
      return autonomyTaskRow(row);
    },
    async releaseAutonomyLease(id, ownerId, leaseToken) {
      return (
        (
          await run(
            "UPDATE nova_autonomy_tasks SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2 AND lease_token=$3 RETURNING id",
            [id, ownerId, leaseToken],
          )
        ).length > 0
      );
    },
    async recordAutonomyStep(input) {
      return autonomyStepRow(
        (
          await run(
            `INSERT INTO nova_autonomy_steps (task_id,step_id,step_type,capability,operation_fingerprint,status,attempt,input,started_at,completed_at,result,error_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::timestamptz,now()),$10,$11::jsonb,$12) ON CONFLICT (task_id,operation_fingerprint) DO UPDATE SET task_id=nova_autonomy_steps.task_id RETURNING *`,
            [
              input.taskId,
              input.stepId,
              input.stepType,
              input.capability,
              input.operationFingerprint,
              input.status || "running",
              input.attempt || 1,
              JSON.stringify(input.input || {}),
              input.startedAt || null,
              input.completedAt || null,
              input.result === undefined ? null : JSON.stringify(input.result),
              input.errorCode || null,
            ],
          )
        )[0],
      );
    },
    async updateAutonomyStep(taskId, stepId, patch) {
      const fields = {
        status: "status",
        attempt: "attempt",
        result: "result",
        errorCode: "error_code",
        startedAt: "started_at",
        completedAt: "completed_at",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      const params = [taskId, stepId];
      const sets = entries.map(([key, value], i) => {
        params.push(key === "result" ? JSON.stringify(value) : value);
        return `${fields[key]}=$${i + 3}${key === "result" ? "::jsonb" : ""}`;
      });
      return autonomyStepRow(
        (
          await run(
            `UPDATE nova_autonomy_steps SET ${sets.join(",")} WHERE task_id=$1 AND step_id=$2 RETURNING *`,
            params,
          )
        )[0],
      );
    },
    async listAutonomySteps(taskId) {
      return (
        await run(
          "SELECT * FROM nova_autonomy_steps WHERE task_id=$1 ORDER BY created_at,step_id",
          [taskId],
        )
      ).map(autonomyStepRow);
    },
    async acquireAutonomyLock({ lockKey, taskId, leaseToken, expiresAt }) {
      return (
        (
          await run(
            `INSERT INTO nova_autonomy_locks (lock_key,task_id,lease_token,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (lock_key) DO UPDATE SET task_id=EXCLUDED.task_id,lease_token=EXCLUDED.lease_token,expires_at=EXCLUDED.expires_at WHERE nova_autonomy_locks.expires_at<=now() OR nova_autonomy_locks.task_id=EXCLUDED.task_id RETURNING lock_key`,
            [lockKey, taskId, leaseToken, expiresAt],
          )
        ).length > 0
      );
    },
    async releaseAutonomyLocks(taskId, leaseToken) {
      return (
        await run(
          "DELETE FROM nova_autonomy_locks WHERE task_id=$1 AND ($2::text IS NULL OR lease_token=$2) RETURNING lock_key",
          [taskId, leaseToken || null],
        )
      ).length;
    },
    async createApproval(input) {
      return approvalRow(
        (
          await run(
            "INSERT INTO nova_approvals (id,owner_id,project_id,run_id,tool,reason,risk_level,arguments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *",
            [
              input.id || randomUUID(),
              input.ownerId,
              input.projectId || null,
              input.runId || null,
              input.tool,
              input.reason,
              input.riskLevel,
              JSON.stringify(input.arguments || {}),
            ],
          )
        )[0],
      );
    },
    async getApproval(id, ownerId) {
      return approvalRow(
        (
          await run(
            "SELECT * FROM nova_approvals WHERE id=$1 AND owner_id=$2",
            [id, ownerId],
          )
        )[0],
      );
    },
    async decideApproval(id, ownerId, decision) {
      return approvalRow(
        (
          await run(
            "UPDATE nova_approvals SET status=$3,decision=$3,decided_at=now() WHERE id=$1 AND owner_id=$2 AND status='pending' RETURNING *",
            [id, ownerId, decision],
          )
        )[0],
      );
    },
    async listApprovals(ownerId, { status, limit = 50 } = {}) {
      return (
        await run(
          "SELECT * FROM nova_approvals WHERE owner_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,id ASC LIMIT $3",
          [ownerId, status || null, limit],
        )
      ).map(approvalRow);
    },
    async appendActivity(input) {
      return activityRow(
        (
          await run(
            "INSERT INTO nova_activity_events (id,owner_id,project_id,run_id,action,tool,status,summary,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *",
            [
              input.id || randomUUID(),
              input.ownerId,
              input.projectId || null,
              input.runId || null,
              input.action,
              input.tool || null,
              input.status,
              input.summary,
              JSON.stringify(input.metadata || {}),
            ],
          )
        )[0],
      );
    },
    async listActivity(ownerId, { projectId, runId, limit = 100 } = {}) {
      return (
        await run(
          "SELECT * FROM nova_activity_events WHERE owner_id=$1 AND ($2::text IS NULL OR project_id=$2) AND ($3::text IS NULL OR run_id=$3) ORDER BY sequence DESC LIMIT $4",
          [ownerId, projectId || null, runId || null, limit],
        )
      ).map(activityRow);
    },
    async createVoiceBenchmarkSession(input) {
      return benchmarkSessionRow(
        (
          await run(
            "INSERT INTO nova_voice_benchmark_sessions (id,owner_id,budget_usd,created_at) VALUES ($1,$2,$3,$4) RETURNING *",
            [
              input.id || randomUUID(),
              input.ownerId,
              input.budgetUsd,
              input.createdAt || new Date().toISOString(),
            ],
          )
        )[0],
      );
    },
    async getVoiceBenchmarkSession(id, ownerId) {
      return benchmarkSessionRow(
        (
          await run(
            "SELECT * FROM nova_voice_benchmark_sessions WHERE id=$1 AND owner_id=$2",
            [id, ownerId],
          )
        )[0],
      );
    },
    async createVoiceBenchmarkResult(input) {
      return benchmarkResultRow(
        (
          await run(
            `INSERT INTO nova_voice_benchmark_results (id,session_id,owner_id,kind,provider_id,sample_id,label,status,estimated_cost_usd,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
            [
              input.id || randomUUID(),
              input.sessionId,
              input.ownerId,
              input.kind,
              input.providerId,
              input.sampleId,
              input.label,
              input.status,
              input.estimatedCostUsd || 0,
              JSON.stringify(input.metadata || {}),
            ],
          )
        )[0],
      );
    },
    async reserveVoiceBenchmarkResult(input, budgetUsd) {
      const estimate = Number(input.estimatedCostUsd || 0);
      const reserved = (
        await run(
          `INSERT INTO nova_voice_benchmark_budgets (owner_id,reserved_usd,cap_usd) VALUES ($1,$2,$3) ON CONFLICT (owner_id) DO UPDATE SET reserved_usd=nova_voice_benchmark_budgets.reserved_usd+EXCLUDED.reserved_usd,cap_usd=LEAST(nova_voice_benchmark_budgets.cap_usd,EXCLUDED.cap_usd),updated_at=now() WHERE nova_voice_benchmark_budgets.reserved_usd+EXCLUDED.reserved_usd<=LEAST(nova_voice_benchmark_budgets.cap_usd,EXCLUDED.cap_usd) RETURNING reserved_usd`,
          [input.ownerId, estimate, budgetUsd],
        )
      )[0];
      if (!reserved) return null;
      return benchmarkResultRow(
        (
          await run(
            `INSERT INTO nova_voice_benchmark_results (id,session_id,owner_id,kind,provider_id,sample_id,label,status,estimated_cost_usd,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
            [
              input.id || randomUUID(),
              input.sessionId,
              input.ownerId,
              input.kind,
              input.providerId,
              input.sampleId,
              input.label,
              input.status,
              estimate,
              JSON.stringify(input.metadata || {}),
            ],
          )
        )[0],
      );
    },
    async updateVoiceBenchmarkResult(id, ownerId, patch) {
      const fields = {
        status: "status",
        latencyMs: "latency_ms",
        transcript: "transcript",
        metrics: "metrics",
        ratings: "ratings",
        model: "model",
        voice: "voice",
        revealed: "revealed",
        error: "error",
      };
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      if (!entries.length)
        return benchmarkResultRow(
          (
            await run(
              "SELECT * FROM nova_voice_benchmark_results WHERE id=$1 AND owner_id=$2",
              [id, ownerId],
            )
          )[0],
        );
      const params = [id, ownerId];
      const sets = entries.map(([key, value], index) => {
        params.push(
          ["metrics", "ratings"].includes(key) ? JSON.stringify(value) : value,
        );
        return `${fields[key]}=$${index + 3}${["metrics", "ratings"].includes(key) ? "::jsonb" : ""}`;
      });
      return benchmarkResultRow(
        (
          await run(
            `UPDATE nova_voice_benchmark_results SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
            params,
          )
        )[0],
      );
    },
    async listVoiceBenchmarkResults(sessionId, ownerId) {
      return (
        await run(
          "SELECT * FROM nova_voice_benchmark_results WHERE session_id=$1 AND owner_id=$2 ORDER BY created_at ASC,id ASC",
          [sessionId, ownerId],
        )
      ).map(benchmarkResultRow);
    },
    async sumVoiceBenchmarkCost(ownerId) {
      return Number(
        (
          await run(
            "SELECT COALESCE((SELECT reserved_usd FROM nova_voice_benchmark_budgets WHERE owner_id=$1),(SELECT COALESCE(SUM(estimated_cost_usd),0) FROM nova_voice_benchmark_results WHERE owner_id=$1),0) AS total",
            [ownerId],
          )
        )[0]?.total || 0,
      );
    },
  };
  return Object.freeze(storage);
}
