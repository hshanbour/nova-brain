import { randomUUID } from "node:crypto";
import { rankRelevantMemories } from "../memory/relevance.js";

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}
function now(clock) {
  return clock().toISOString();
}

export function createInMemoryStorage({ clock = () => new Date() } = {}) {
  const owners = new Map();
  const projects = new Map();
  const conversations = new Map();
  const messages = new Map();
  const memories = new Map();
  const speakerProfiles = new Map();
  const anonymousSpeakerProfiles = new Map();
  const voiceUtterances = new Map();
  const runs = new Map();
  const autonomyTasks = new Map();
  const autonomySteps = new Map();
  const autonomyLocks = new Map();
  const approvals = new Map();
  const activity = [];
  const benchmarkSessions = new Map();
  const benchmarkResults = new Map();
  const benchmarkBudgets = new Map();
  let sequence = 0;

  return Object.freeze({
    provider: "memory",
    durable: false,
    async initialize({
      owner,
      projects: seedProjects = [],
      memories: seedMemories = [],
    } = {}) {
      if (owner && !owners.has(owner.id)) {
        const timestamp = now(clock);
        owners.set(owner.id, {
          ...copy(owner),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      for (const project of seedProjects)
        if (!projects.has(project.id))
          projects.set(project.id, {
            ...copy(project),
            ownerId: owner.id,
            createdAt: now(clock),
            updatedAt: now(clock),
          });
      for (const memory of seedMemories) {
        const current = memories.get(memory.id);
        if (!current)
          memories.set(memory.id, {
            ...copy(memory),
            ownerId: owner.id,
            createdAt: now(clock),
            updatedAt: now(clock),
          });
        else if (memory.provenance === "system-generated-project-release")
          memories.set(memory.id, {
            ...current,
            ...copy(memory),
            ownerId: owner.id,
            createdAt: current.createdAt,
            updatedAt: now(clock),
          });
      }
    },
    async health() {
      return { provider: "memory", durable: false, status: "ready" };
    },
    async getOwner(ownerId) {
      return copy(owners.get(ownerId) || null);
    },
    async updateOwner(ownerId, patch) {
      const current = owners.get(ownerId);
      if (!current) return null;
      const updated = {
        ...current,
        ...copy(patch),
        id: ownerId,
        createdAt: current.createdAt,
        updatedAt: now(clock),
      };
      owners.set(ownerId, updated);
      return copy(updated);
    },
    async listProjects(ownerId) {
      return [...projects.values()]
        .filter((item) => item.ownerId === ownerId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(copy);
    },
    async ensureConversation({ id = randomUUID(), ownerId, title = null }) {
      const current = conversations.get(id);
      if (current) return current.ownerId === ownerId ? copy(current) : null;
      const timestamp = now(clock);
      const conversation = {
        id,
        ownerId,
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      conversations.set(id, conversation);
      messages.set(id, []);
      return copy(conversation);
    },
    async listConversations(ownerId, { limit = 20 } = {}) {
      return [...conversations.values()]
        .filter((item) => item.ownerId === ownerId)
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map(copy);
    },
    async appendMessage({ conversationId, ownerId, role, content }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId)
        throw new Error("Conversation not found.");
      const entry = {
        id: randomUUID(),
        conversationId,
        ownerId,
        role,
        content,
        sequence: ++sequence,
        createdAt: now(clock),
      };
      messages.set(conversationId, [
        ...(messages.get(conversationId) || []),
        entry,
      ]);
      conversation.updatedAt = entry.createdAt;
      return copy(entry);
    },
    async listMessages(
      conversationId,
      ownerId,
      { limit = 30, offset = 0 } = {},
    ) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) return [];
      const history = messages.get(conversationId) || [];
      const end = history.length - offset;
      const start = Math.max(0, end - limit);
      return end <= 0 ? [] : history.slice(start, end).map(copy);
    },
    async createMemory(input) {
      const timestamp = now(clock);
      const memory = {
        id: input.id || randomUUID(),
        ...copy(input),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      memories.set(memory.id, memory);
      return copy(memory);
    },
    async getMemory(id, ownerId) {
      const memory = memories.get(id);
      return copy(
        memory?.ownerId === ownerId && memory.status !== "deleted"
          ? memory
          : null,
      );
    },
    async listMemories(
      ownerId,
      { category, scope, projectId, limit = 100 } = {},
    ) {
      return [...memories.values()]
        .filter(
          (item) =>
            item.ownerId === ownerId &&
            item.status !== "deleted" &&
            (!category || item.category === category) &&
            (!scope || item.scope === scope) &&
            (!projectId || item.projectId === projectId),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map(copy);
    },
    async updateMemory(id, ownerId, patch) {
      const current = memories.get(id);
      if (
        !current ||
        current.ownerId !== ownerId ||
        current.status === "deleted"
      )
        return null;
      const updated = {
        ...current,
        ...copy(patch),
        id,
        ownerId,
        createdAt: current.createdAt,
        updatedAt: now(clock),
      };
      memories.set(id, updated);
      return copy(updated);
    },
    async deleteMemory(id, ownerId) {
      const current = memories.get(id);
      if (!current || current.ownerId !== ownerId) return false;
      memories.set(id, {
        ...current,
        status: "deleted",
        updatedAt: now(clock),
        deletedAt: now(clock),
      });
      return true;
    },
    async retrieveMemories(ownerId, query, { projectId, limit = 6 } = {}) {
      return rankRelevantMemories(
        [...memories.values()].filter((item) => item.ownerId === ownerId),
        query,
        { projectId, limit },
      ).map(copy);
    },
    async createSpeakerProfile(input) {
      const existing = [...speakerProfiles.values()].find(
        (item) =>
          input.enrollmentAttemptId &&
          item.ownerId === input.ownerId &&
          item.enrollmentAttemptId === input.enrollmentAttemptId,
      );
      if (existing) return copy(existing);
      const timestamp = now(clock);
      const profile = {
        ...copy(input),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      speakerProfiles.set(profile.id, profile);
      return copy(profile);
    },
    async getSpeakerProfileByEnrollmentAttempt(ownerId, enrollmentAttemptId) {
      return copy(
        [...speakerProfiles.values()].find(
          (item) =>
            item.ownerId === ownerId &&
            item.enrollmentAttemptId === enrollmentAttemptId,
        ) || null,
      );
    },
    async listSpeakerProfiles(ownerId, { includeRepresentation = false } = {}) {
      return [...speakerProfiles.values()]
        .filter((item) => item.ownerId === ownerId)
        .map((item) => {
          const value = copy(item);
          if (!includeRepresentation) delete value.representation;
          return value;
        });
    },
    async updateSpeakerProfile(id, ownerId, patch) {
      const current = speakerProfiles.get(id);
      if (!current || current.ownerId !== ownerId) return null;
      const updated = {
        ...current,
        ...copy(patch),
        id,
        ownerId,
        createdAt: current.createdAt,
        updatedAt: now(clock),
      };
      speakerProfiles.set(id, updated);
      return copy(updated);
    },
    async deleteSpeakerProfile(id, ownerId) {
      const current = speakerProfiles.get(id);
      if (!current || current.ownerId !== ownerId) return false;
      speakerProfiles.delete(id);
      return true;
    },
    async createAnonymousSpeakerProfile(input) {
      const timestamp = now(clock);
      const profile = {
        ...copy(input),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      anonymousSpeakerProfiles.set(profile.id, profile);
      return copy(profile);
    },
    async listAnonymousSpeakerProfiles(
      ownerId,
      { includeRepresentation = false } = {},
    ) {
      return [...anonymousSpeakerProfiles.values()]
        .filter((item) => item.ownerId === ownerId && item.status !== "deleted")
        .map((item) => {
          const value = copy(item);
          if (!includeRepresentation) delete value.representation;
          return value;
        });
    },
    async updateAnonymousSpeakerProfile(id, ownerId, patch) {
      const current = anonymousSpeakerProfiles.get(id);
      if (
        !current ||
        current.ownerId !== ownerId ||
        current.status === "deleted"
      )
        return null;
      const updated = {
        ...current,
        ...copy(patch),
        id,
        ownerId,
        createdAt: current.createdAt,
        updatedAt: now(clock),
      };
      anonymousSpeakerProfiles.set(id, updated);
      return copy(updated);
    },
    async deleteAnonymousSpeakerProfile(id, ownerId) {
      const current = anonymousSpeakerProfiles.get(id);
      if (
        !current ||
        current.ownerId !== ownerId ||
        current.status === "deleted"
      )
        return false;
      anonymousSpeakerProfiles.set(id, {
        ...current,
        status: "deleted",
        representation: null,
        deletedAt: now(clock),
        updatedAt: now(clock),
      });
      return true;
    },
    async purgeInvalidOwnerSpeakerEnrollment(ownerId) {
      const targets = [...speakerProfiles.values()].filter(
        (item) => item.ownerId === ownerId && item.relation === "owner",
      );
      const targetIds = targets.map((item) => item.id);
      for (const id of targetIds) speakerProfiles.delete(id);
      let utterancesScrubbed = 0;
      for (const [id, item] of voiceUtterances) {
        if (
          item.ownerId === ownerId &&
          (targetIds.includes(item.speakerProfileId) ||
            item.speakerLabel === "owner")
        ) {
          voiceUtterances.set(id, {
            ...item,
            speakerProfileId: null,
            speakerLabel: "unknown",
            confidence: null,
          });
          utterancesScrubbed += 1;
        }
      }
      let auditReferencesDeleted = 0;
      for (let index = activity.length - 1; index >= 0; index -= 1) {
        const item = activity[index];
        if (
          item.ownerId === ownerId &&
          (item.action?.startsWith("speaker_") ||
            item.metadata?.speakerProfileId)
        ) {
          activity.splice(index, 1);
          auditReferencesDeleted += 1;
        }
      }
      return {
        profilesDeleted: targetIds.length,
        voiceprintsDeleted: targets.filter((item) => item.representation)
          .length,
        utterancesScrubbed,
        auditReferencesDeleted,
      };
    },
    async speakerPrivacyStatus(ownerId) {
      const ownerProfiles = [...speakerProfiles.values()].filter(
        (item) => item.ownerId === ownerId && item.relation === "owner",
      );
      const ownerProfileIds = new Set(ownerProfiles.map((item) => item.id));
      return {
        ownerProfiles: ownerProfiles.length,
        encryptedVoiceprints: ownerProfiles.filter(
          (item) => item.representation,
        ).length,
        linkedUtterances: [...voiceUtterances.values()].filter(
          (item) =>
            item.ownerId === ownerId &&
            (ownerProfileIds.has(item.speakerProfileId) ||
              item.speakerLabel === "owner"),
        ).length,
        identifyingAuditReferences: activity.filter(
          (item) =>
            item.ownerId === ownerId &&
            (item.action?.startsWith("speaker_") ||
              item.metadata?.speakerProfileId),
        ).length,
        rawAudioObjects: 0,
      };
    },
    async createVoiceUtterance(input) {
      const utterance = { ...copy(input), createdAt: now(clock) };
      voiceUtterances.set(utterance.id, utterance);
      return copy(utterance);
    },
    async listVoiceUtterances(conversationId, ownerId, { limit = 100 } = {}) {
      return [...voiceUtterances.values()]
        .filter(
          (item) =>
            item.ownerId === ownerId && item.conversationId === conversationId,
        )
        .slice(-limit)
        .map(copy);
    },
    async createRun({
      id = randomUUID(),
      ownerId,
      projectId = null,
      conversationId = null,
      goal,
      status = "planning",
    }) {
      const timestamp = now(clock);
      const run = {
        id,
        ownerId,
        projectId,
        conversationId,
        goal,
        status,
        currentStep: 0,
        result: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      };
      runs.set(id, run);
      return copy(run);
    },
    async updateRun(id, ownerId, patch) {
      const current = runs.get(id);
      if (!current || current.ownerId !== ownerId) return null;
      const updated = {
        ...current,
        ...copy(patch),
        id,
        ownerId,
        updatedAt: now(clock),
      };
      runs.set(id, updated);
      return copy(updated);
    },
    async listRuns(ownerId, { projectId, limit = 50 } = {}) {
      return [...runs.values()]
        .filter(
          (item) =>
            item.ownerId === ownerId &&
            (!projectId || item.projectId === projectId),
        )
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map(copy);
    },
    async createAutonomyTask(input) {
      const timestamp = now(clock);
      const task = {
        id: input.id || randomUUID(),
        ownerId: input.ownerId,
        projectId: input.projectId || null,
        title: input.title,
        objective: input.objective,
        taskType: input.taskType || "developer",
        status: "queued",
        priority: input.priority || 0,
        currentPhase: "queued",
        currentStep: 0,
        maxSteps: input.maxSteps || 30,
        maxRetries: input.maxRetries ?? 3,
        maxRuntimeMinutes: input.maxRuntimeMinutes || 30,
        branch: input.branch || null,
        startingCommit: input.startingCommit || null,
        currentCommit: input.startingCommit || null,
        checkpoint: { completedSteps: [], pendingStep: null, findings: [] },
        approvalState: null,
        blockedReason: null,
        resultSummary: null,
        errorCode: null,
        nextRunAt: input.nextRunAt || timestamp,
        metadata: copy(input.metadata || {}),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        retryCount: 0,
        repairIteration: 0,
        stateVersion: 1,
        createdAt: timestamp,
        startedAt: null,
        updatedAt: timestamp,
        completedAt: null,
      };
      autonomyTasks.set(task.id, task);
      return copy(task);
    },
    async getAutonomyTask(id, ownerId) {
      const task = autonomyTasks.get(id);
      return copy(task?.ownerId === ownerId ? task : null);
    },
    async listAutonomyTasks(ownerId, { status, limit = 50 } = {}) {
      return [...autonomyTasks.values()]
        .filter(
          (x) => x.ownerId === ownerId && (!status || x.status === status),
        )
        .sort(
          (a, b) =>
            b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
        )
        .slice(0, limit)
        .map(copy);
    },
    async updateAutonomyTask(id, ownerId, patch, expectedVersion) {
      const current = autonomyTasks.get(id);
      if (!current || current.ownerId !== ownerId || (expectedVersion!==undefined&&current.stateVersion!==expectedVersion)) return null;
      const updated = {
        ...current,
        ...copy(patch),
        id,
        ownerId,
        createdAt: current.createdAt,
        stateVersion: current.stateVersion + 1,
        updatedAt: now(clock),
      };
      autonomyTasks.set(id, updated);
      return copy(updated);
    },
    async migrateAutonomyTask(input) {
      const current = autonomyTasks.get(input.taskId);
      if (
        !current ||
        current.ownerId !== input.ownerId ||
        current.stateVersion !== input.expectedVersion ||
        current.branch !== input.expectedBranch ||
        current.currentCommit !== input.expectedCommit ||
        (current.leaseToken && new Date(current.leaseExpiresAt) > clock())
      )
        return null;
      const before = copy(current);
      try {
        const metadata = {
          ...current.metadata,
          steps: copy(input.plan),
          migrationPlanVersion: input.planVersion,
          requiredCapability: input.requiredCapability,
        };
        const updated = {
          ...current,
          status: "queued",
          startingCommit: input.targetCommit,
          currentCommit: input.targetCommit,
          maxSteps: Math.max(current.maxSteps, input.plan.length + 2),
          maxRuntimeMinutes: input.runtimeMinutes,
          startedAt: now(clock),
          completedAt: null,
          nextRunAt: now(clock),
          blockedReason: null,
          errorCode: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          metadata,
          stateVersion: current.stateVersion + 1,
          updatedAt: now(clock),
        };
        autonomyTasks.set(input.taskId, updated);
        await this.appendActivity({
          ownerId: input.ownerId,
          projectId: current.projectId,
          runId: current.id,
          action: "autonomy_task_migrated",
          status: "completed",
          summary: "Repaired an allowlisted Worker task continuation.",
          metadata: {
            taskId: current.id,
            migrationType: "repair_worker_runtime_v1_continuation",
            oldCommit: input.expectedCommit,
            newCommit: input.targetCommit,
            oldRuntimeMinutes: input.oldRuntimeMinutes,
            newRuntimeMinutes: input.runtimeMinutes,
            oldPlanVersion: input.oldPlanVersion,
            newPlanVersion: input.planVersion,
            actorType: input.actorType,
            expectedVersion: input.expectedVersion,
            newVersion: input.expectedVersion + 1,
            result: "completed",
          },
        });
        return copy(updated);
      } catch (error) {
        autonomyTasks.set(input.taskId, before);
        throw error;
      }
    },
    async recoverExpiredAutonomyTask(input) {
      const current=autonomyTasks.get(input.taskId);
      if(!current||current.ownerId!==input.ownerId||current.stateVersion!==input.expectedVersion||current.status!=="expired"||current.errorCode!=="max_runtime_reached"||current.branch!==input.expectedBranch||current.currentCommit!==input.expectedCommit||current.leaseToken||current.leaseOwner||current.leaseExpiresAt)return null;
      const before=copy(current);try{
        const recovered={...current,status:"queued",currentStep:9,currentPhase:"post_attestation_recovery",maxSteps:Math.max(current.maxSteps,input.plan.length+1),maxRuntimeMinutes:input.runtimeMinutes,startedAt:now(clock),completedAt:null,nextRunAt:now(clock),blockedReason:null,errorCode:null,metadata:{...current.metadata,steps:copy(input.plan),requiredCapability:"vercel_preview",postAttestationRecovery:{previousStatus:"expired",previousErrorCode:"max_runtime_reached",previousStartedAt:input.previousStartedAt,previousCompletedAt:input.previousCompletedAt,recoveredAt:now(clock)}},stateVersion:current.stateVersion+1,updatedAt:now(clock)};
        autonomyTasks.set(input.taskId,recovered);await this.appendActivity({ownerId:input.ownerId,projectId:current.projectId,runId:current.id,action:"autonomy_post_attestation_expiry_recovered",status:"completed",summary:"Recovered the exact expired post-attestation verification continuation.",metadata:{taskId:current.id,previousStatus:"expired",previousErrorCode:"max_runtime_reached",newRuntimeMinutes:input.runtimeMinutes,actorType:input.actorType,expectedVersion:input.expectedVersion,newVersion:input.expectedVersion+1,result:"completed"}});return copy(recovered);
      }catch(error){autonomyTasks.set(input.taskId,before);throw error;}
    },
    async claimAutonomyTask({
      ownerId,
      workerId,
      capabilities,
      leaseMs = 30000,
      idempotencyKey,
      taskId,
      expectedBranch,
      expectedCommit,
      expectedVersion,
    }) {
      const timestamp = clock();
      for (const task of autonomyTasks.values())
        if (
          task.ownerId === ownerId &&
          (!taskId || task.id === taskId) &&
          task.leaseExpiresAt &&
          new Date(task.leaseExpiresAt) <= timestamp &&
          ["running", "planning", "retrying"].includes(task.status)
        ) {
          task.status = "queued";
          task.leaseOwner = null;
          task.leaseToken = null;
          task.leaseExpiresAt = null;
          task.stateVersion += 1;
          task.updatedAt = timestamp.toISOString();
        }
      const eligible = [...autonomyTasks.values()]
        .filter(
          (t) =>
            t.ownerId === ownerId &&
            (!taskId || t.id === taskId) &&
            (!expectedBranch || t.branch === expectedBranch) &&
            (!expectedCommit || t.currentCommit === expectedCommit) &&
            (expectedVersion === undefined || t.stateVersion === expectedVersion) &&
            (["queued", "retrying", "waiting_for_worker"].includes(t.status) ||
              (t.status === "waiting" && t.nextRunAt)) &&
            (!t.nextRunAt || new Date(t.nextRunAt) <= timestamp) &&
            (!t.metadata?.requiredCapability ||
              capabilities.includes(t.metadata.requiredCapability)),
        )
        .sort(
          (a, b) =>
            b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
        )[0];
      if (!eligible) return null;
      if (eligible.leaseToken && eligible.metadata?.claimKey === idempotencyKey)
        return copy(eligible);
      eligible.status = eligible.startedAt ? "running" : "planning";
      eligible.startedAt ||= timestamp.toISOString();
      eligible.leaseOwner = workerId;
      eligible.leaseToken = randomUUID();
      eligible.leaseExpiresAt = new Date(
        timestamp.getTime() + leaseMs,
      ).toISOString();
      eligible.metadata = { ...eligible.metadata, claimKey: idempotencyKey };
      eligible.stateVersion += 1;
      eligible.updatedAt = timestamp.toISOString();
      return copy(eligible);
    },
    async releaseAutonomyLease(id, ownerId, leaseToken) {
      const task = autonomyTasks.get(id);
      if (!task || task.ownerId !== ownerId || task.leaseToken !== leaseToken)
        return false;
      task.leaseOwner = null;
      task.leaseToken = null;
      task.leaseExpiresAt = null;
      task.stateVersion += 1;
      task.updatedAt = now(clock);
      return true;
    },
    async recordAutonomyStep(input) {
      const key = `${input.taskId}:${input.stepId}`;
      const fingerprint = [...autonomySteps.values()].find(
        (x) =>
          x.taskId === input.taskId &&
          x.operationFingerprint === input.operationFingerprint,
      );
      if (fingerprint) return copy(fingerprint);
      const step = {
        ...copy(input),
        status: input.status || "running",
        attempt: input.attempt || 1,
        createdAt: now(clock),
        startedAt: input.startedAt || now(clock),
        completedAt: input.completedAt || null,
      };
      autonomySteps.set(key, step);
      return copy(step);
    },
    async updateAutonomyStep(taskId, stepId, patch) {
      const key = `${taskId}:${stepId}`,
        current = autonomySteps.get(key);
      if (!current) return null;
      const updated = { ...current, ...copy(patch) };
      autonomySteps.set(key, updated);
      return copy(updated);
    },
    async listAutonomySteps(taskId) {
      return [...autonomySteps.values()]
        .filter((x) => x.taskId === taskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(copy);
    },
    async acquireAutonomyLock({ lockKey, taskId, leaseToken, expiresAt }) {
      const current = autonomyLocks.get(lockKey);
      if (
        current &&
        new Date(current.expiresAt) > clock() &&
        current.taskId !== taskId
      )
        return false;
      autonomyLocks.set(lockKey, { lockKey, taskId, leaseToken, expiresAt });
      return true;
    },
    async releaseAutonomyLocks(taskId, leaseToken) {
      let count = 0;
      for (const [key, value] of autonomyLocks)
        if (
          value.taskId === taskId &&
          (!leaseToken || value.leaseToken === leaseToken)
        ) {
          autonomyLocks.delete(key);
          count++;
        }
      return count;
    },
    async createApproval(input) {
      const approval = {
        id: input.id || randomUUID(),
        ...copy(input),
        status: "pending",
        decision: null,
        createdAt: now(clock),
        decidedAt: null,
      };
      approvals.set(approval.id, approval);
      return copy(approval);
    },
    async getApproval(id, ownerId) {
      const item = approvals.get(id);
      return copy(item?.ownerId === ownerId ? item : null);
    },
    async decideApproval(id, ownerId, decision) {
      const current = approvals.get(id);
      if (
        !current ||
        current.ownerId !== ownerId ||
        current.status !== "pending"
      )
        return null;
      const updated = {
        ...current,
        status: decision === "approved" ? "approved" : "rejected",
        decision,
        decidedAt: now(clock),
      };
      approvals.set(id, updated);
      return copy(updated);
    },
    async listApprovals(ownerId, { status, limit = 50 } = {}) {
      return [...approvals.values()]
        .filter(
          (item) =>
            item.ownerId === ownerId && (!status || item.status === status),
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map(copy);
    },
    async appendActivity(input) {
      const event = {
        id: input.id || randomUUID(),
        ...copy(input),
        sequence: ++sequence,
        createdAt: now(clock),
      };
      activity.push(event);
      return copy(event);
    },
    async listActivity(ownerId, { projectId, runId, limit = 100 } = {}) {
      return activity
        .filter(
          (item) =>
            item.ownerId === ownerId &&
            (!projectId || item.projectId === projectId) &&
            (!runId || item.runId === runId),
        )
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, limit)
        .map(copy);
    },
    async createVoiceBenchmarkSession(input) {
      const session = {
        id: input.id || randomUUID(),
        ownerId: input.ownerId,
        budgetUsd: input.budgetUsd,
        createdAt: input.createdAt || now(clock),
      };
      benchmarkSessions.set(session.id, session);
      return copy(session);
    },
    async getVoiceBenchmarkSession(id, ownerId) {
      const session = benchmarkSessions.get(id);
      return copy(session?.ownerId === ownerId ? session : null);
    },
    async createVoiceBenchmarkResult(input) {
      const allowed = sanitiseBenchmark(input);
      const result = {
        ...allowed,
        createdAt: now(clock),
        updatedAt: now(clock),
        latencyMs: null,
        transcript: null,
        metrics: null,
        ratings: null,
        revealed: false,
        error: null,
      };
      benchmarkResults.set(result.id, result);
      return copy(result);
    },
    async reserveVoiceBenchmarkResult(input, budgetUsd) {
      const spent =
        benchmarkBudgets.get(input.ownerId) ??
        [...benchmarkResults.values()]
          .filter((item) => item.ownerId === input.ownerId)
          .reduce((sum, item) => sum + Number(item.estimatedCostUsd || 0), 0);
      const next = spent + Number(input.estimatedCostUsd || 0);
      if (next > budgetUsd + Number.EPSILON) return null;
      benchmarkBudgets.set(input.ownerId, next);
      const allowed = sanitiseBenchmark(input);
      const result = {
        ...allowed,
        createdAt: now(clock),
        updatedAt: now(clock),
        latencyMs: null,
        transcript: null,
        metrics: null,
        ratings: null,
        revealed: false,
        error: null,
      };
      benchmarkResults.set(result.id, result);
      return copy(result);
    },
    async updateVoiceBenchmarkResult(id, ownerId, patch) {
      const current = benchmarkResults.get(id);
      if (!current || current.ownerId !== ownerId) return null;
      const updated = {
        ...current,
        ...sanitiseBenchmark(patch),
        id,
        ownerId,
        updatedAt: now(clock),
      };
      benchmarkResults.set(id, updated);
      return copy(updated);
    },
    async listVoiceBenchmarkResults(sessionId, ownerId) {
      return [...benchmarkResults.values()]
        .filter(
          (item) => item.sessionId === sessionId && item.ownerId === ownerId,
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )
        .map(copy);
    },
    async sumVoiceBenchmarkCost(ownerId) {
      return (
        benchmarkBudgets.get(ownerId) ??
        [...benchmarkResults.values()]
          .filter((item) => item.ownerId === ownerId)
          .reduce((sum, item) => sum + Number(item.estimatedCostUsd || 0), 0)
      );
    },
  });
}

function sanitiseBenchmark(input) {
  const { audio, audioBase64, audioData, ...safe } = copy(input || {});
  return safe;
}
