import { randomUUID } from "node:crypto";
import { rankRelevantMemories } from "../memory/relevance.js";
import {validateRejectedReviewEvidenceEnvelope} from "../autonomy/rejected-review-evidence.js";

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}
function now(clock) {
  return clock().toISOString();
}
function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}
const sameJson = (left, right) => JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));

export function createInMemoryStorage({ clock = () => new Date() } = {}) {
  const owners = new Map();
  const projects = new Map();
  const conversations = new Map();
  const messages = new Map();
  const taskReportOutbox = new Map();
  const memories = new Map();
  const memoryCandidates = new Map();
  const speakerProfiles = new Map();
  const speakerChannelCalibrations = new Map();
  const speakerEnrollmentConsents = new Map();
  const speakerEnrollmentSessions = new Map();
  const speakerEnrollmentSamples = new Map();
  const speakerControlSessions = new Map();
  const speakerControlSamples = new Map();
  const anonymousSpeakerProfiles = new Map();
  const voiceUtterances = new Map();
  const runs = new Map();
  const autonomyTasks = new Map();
  const executionAttempts = new Map();
  const autonomySteps = new Map();
  const rejectedReviewEvidence = new Map();
  const autonomyLocks = new Map();
  const approvals = new Map();
  const gmailOAuthStates = new Map();
  const gmailConnections = new Map();
  const gmailDrafts = new Map();
  const gmailSendIntents = new Map();
  const whatsappInboundMessages = new Map();
  const whatsappOutboundMessages = new Map();
  const phoneCallIntents = new Map();
  const phoneCallEvents = new Map();
  const phoneCallTurns = new Map();
  const ownerContactPolicies = new Map();
  const ownerCallbackEligibilities = new Map();
  const liveConversationStates = new Map();
  const conversationEvents = new Map();
  const developerSessions = new Map();
  const activity = [];
  const benchmarkSessions = new Map();
  const benchmarkResults = new Map();
  const benchmarkBudgets = new Map();
  const modelCostBudgets = new Map();
  const modelCostReservations = new Map();
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
    async appendMessage({ id = randomUUID(), conversationId, ownerId, role, content }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId)
        throw new Error("Conversation not found.");
      const existing = [...messages.values()].flat().find((item) => item.id === id);
      if (existing) {
        if (existing.conversationId !== conversationId || existing.ownerId !== ownerId || existing.role !== role || existing.content !== content)
          throw new Error("Message identity conflict.");
        return copy(existing);
      }
      const entry = {
        id,
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
    async enqueueTaskReport(input) {
      const conversation = conversations.get(input.conversationId), task = autonomyTasks.get(input.taskId);
      if (!conversation || conversation.ownerId !== input.ownerId || !task || task.ownerId !== input.ownerId)
        throw new Error("Invalid task report binding.");
      const existing = taskReportOutbox.get(input.reportKey);
      if (existing) {
        if (JSON.stringify({...existing,createdAt:undefined,deliveredAt:undefined}) !== JSON.stringify({...copy(input),createdAt:undefined,deliveredAt:undefined}))
          throw new Error("Task report identity conflict.");
        return copy(existing);
      }
      const record={...copy(input),createdAt:now(clock),deliveredAt:null};
      taskReportOutbox.set(record.reportKey,record);return copy(record);
    },
    async listPendingTaskReports(ownerId,{limit=50}={}) {
      return [...taskReportOutbox.values()].filter(item=>item.ownerId===ownerId&&!item.deliveredAt).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,limit).map(copy);
    },
    async listTerminalTaskReportCandidates(ownerId,{limit=100}={}) {
      const reported=new Set([...taskReportOutbox.values()].map(item=>`${item.taskId}:${item.terminalStateVersion}`));
      return [...autonomyTasks.values()].filter(item=>item.ownerId===ownerId&&["completed","failed","blocked","cancelled","expired"].includes(item.status)&&item.metadata?.terminalReporting?.version===1&&!reported.has(`${item.id}:${item.stateVersion}`)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit).map(copy);
    },
    async listConversationBoundTasks(ownerId,conversationId,{limit=50}={}) {
      return [...autonomyTasks.values()].filter(item=>item.ownerId===ownerId&&item.metadata?.terminalReporting?.conversationId===conversationId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit).map(copy);
    },
    async deliverTaskReport(reportKey,ownerId) {
      const record=taskReportOutbox.get(reportKey);
      if(!record||record.ownerId!==ownerId)return null;
      await this.appendMessage({id:record.messageId,conversationId:record.conversationId,ownerId,role:"assistant",content:record.content});
      if(!record.deliveredAt)record.deliveredAt=now(clock);
      return copy(record);
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
    async ensureLiveConversationState({ conversationId, ownerId, rollingSummary = "", unresolvedState = {} }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) throw new Error("Conversation not found.");
      const current = liveConversationStates.get(conversationId);
      if (current) return copy(current);
      const record = { conversationId, ownerId, contextVersion: 0, rollingSummary: String(rollingSummary).slice(0, 16_384), unresolvedState: copy(unresolvedState), createdAt: now(clock), updatedAt: now(clock) };
      liveConversationStates.set(conversationId, record);
      conversationEvents.set(conversationId, []);
      return copy(record);
    },
    async getLiveConversationState(conversationId, ownerId) {
      const record = liveConversationStates.get(conversationId);
      return copy(record?.ownerId === ownerId ? record : null);
    },
    async updateLiveConversationState(conversationId, ownerId, { expectedContextVersion, rollingSummary, unresolvedState }) {
      const current = liveConversationStates.get(conversationId);
      if (!current || current.ownerId !== ownerId) throw new Error("Live conversation not found.");
      if (current.contextVersion !== expectedContextVersion) throw Object.assign(new Error("Live context version conflict."), { code: "live_context_version_conflict" });
      current.contextVersion += 1;
      if (rollingSummary !== undefined) current.rollingSummary = String(rollingSummary).slice(0, 16_384);
      if (unresolvedState !== undefined) current.unresolvedState = copy(unresolvedState);
      current.updatedAt = now(clock);
      return copy(current);
    },
    async appendConversationEvent(input) {
      const conversation = conversations.get(input.conversationId);
      if (!conversation || conversation.ownerId !== input.ownerId) throw new Error("Conversation not found.");
      const all = [...conversationEvents.values()].flat();
      const existing = all.find((item) => item.id === input.id);
      if (existing) {
        if (!sameJson({ ...existing, sequence: undefined, createdAt: undefined }, { ...input, sequence: undefined, createdAt: undefined })) throw new Error("Conversation event identity conflict.");
        return copy(existing);
      }
      const record = { ...copy(input), sequence: ++sequence, createdAt: now(clock) };
      conversationEvents.set(input.conversationId, [...(conversationEvents.get(input.conversationId) || []), record]);
      return copy(record);
    },
    async listConversationEvents(conversationId, ownerId, { limit = 128 } = {}) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) return [];
      return (conversationEvents.get(conversationId) || []).slice(-limit).map(copy);
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
    async supersedeMemory(id, ownerId, replacement) {
      const current=memories.get(id);
      if(!current||current.ownerId!==ownerId||current.status!=="active")return null;
      const timestamp=now(clock),next={id:replacement.id||randomUUID(),...copy(replacement),ownerId,status:"active",createdAt:timestamp,updatedAt:timestamp};
      memories.set(current.id,{...current,status:"superseded",updatedAt:timestamp});
      memories.set(next.id,next);
      return{memory:copy(next),supersededMemory:copy(memories.get(current.id))};
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
    async createMemoryCandidate(input) {
      const existing=[...memoryCandidates.values()].find(item=>item.ownerId===input.ownerId&&item.fingerprint===input.fingerprint);
      if(existing)return copy(existing);
      const timestamp=now(clock),candidate={id:input.id||randomUUID(),ownerId:input.ownerId,projectId:input.projectId||null,conversationId:input.conversationId||null,sourceMessageId:input.sourceMessageId||null,sourceRunId:input.sourceRunId||null,sourceTaskId:input.sourceTaskId||null,sourceKind:input.sourceKind,candidateType:input.candidateType,content:input.content,evidence:copy(input.evidence||{}),provenance:input.provenance,privacy:input.privacy||"private",scope:input.scope||"global",status:"pending",fingerprint:input.fingerprint,supersedesMemoryId:input.supersedesMemoryId||null,acceptedMemoryId:null,decisionReason:null,createdAt:timestamp,updatedAt:timestamp,decidedAt:null};
      memoryCandidates.set(candidate.id,candidate);return copy(candidate);
    },
    async getMemoryCandidate(id,ownerId){const item=memoryCandidates.get(id);return copy(item?.ownerId===ownerId?item:null);},
    async listMemoryCandidates(ownerId,{status,projectId,sourceTaskId,limit=100}={}){
      return [...memoryCandidates.values()].filter(item=>item.ownerId===ownerId&&(!status||item.status===status)&&(!projectId||item.projectId===projectId)&&(!sourceTaskId||item.sourceTaskId===sourceTaskId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)).slice(0,limit).map(copy);
    },
    async decideMemoryCandidate(id,ownerId,{decision,supersedesMemoryId=null,decisionReason=null}={}){
      const current=memoryCandidates.get(id);if(!current||current.ownerId!==ownerId)return null;
      if(current.status===decision)return{candidate:copy(current),memory:current.acceptedMemoryId?copy(memories.get(current.acceptedMemoryId)):null,idempotent:true};
      if(current.status!=="pending")return null;
      if(decision==="accepted"&&current.sourceKind==="completed_task"&&current.evidence?.version>=3&&!['passed','not_required'].includes(current.evidence?.verificationStatus))return null;
      const target=supersedesMemoryId?memories.get(supersedesMemoryId):null;
      if(supersedesMemoryId&&(!target||target.ownerId!==ownerId||target.status!=="active"))return null;
      let memory=null;
      if(decision==="accepted"){
        if(target)memories.set(target.id,{...target,status:"superseded",updatedAt:now(clock)});
        const category=current.candidateType==="correction"&&target?target.category:({preference:"preference",project_decision:"decision",owner_claim:"identity",verified_fact:"identity",hypothesis:"project_context",unresolved_question:"project_context"}[current.candidateType]||"reusable_instruction");
        const memoryId=`memory-candidate-${id}`,timestamp=now(clock);memory={id:memoryId,ownerId,category,content:current.content,provenance:`memory-candidate:${current.sourceKind}:${id}`,privacy:current.privacy,sensitivity:"normal",scope:current.candidateType==="correction"&&target?target.scope:current.scope,projectId:current.candidateType==="correction"&&target?target.projectId:(current.projectId||null),confidence:current.candidateType==="verified_fact"?.95:["owner_claim","preference","project_decision","correction"].includes(current.candidateType)?.9:.8,evidence:copy(current.evidence||{}),status:"active",createdAt:timestamp,updatedAt:timestamp,deletedAt:null};memories.set(memoryId,memory);
      }
      const timestamp=now(clock),candidate={...current,status:decision,acceptedMemoryId:memory?.id||null,supersedesMemoryId:supersedesMemoryId||current.supersedesMemoryId||null,decisionReason:decisionReason||null,decidedAt:timestamp,updatedAt:timestamp};memoryCandidates.set(id,candidate);return{candidate:copy(candidate),memory:copy(memory),idempotent:false};
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
    async getRun(id, ownerId) {
      const run = runs.get(id);
      return copy(run?.ownerId === ownerId ? run : null);
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
    async prepareAutonomyTaskBundle({ task, run, step, activity: initialActivity }) {
      if (
        !task?.id ||
        run?.id !== task.id ||
        step?.taskId !== task.id ||
        initialActivity?.runId !== task.id
      )
        throw Object.assign(
          new Error("The autonomy task preparation binding is invalid."),
          { code: "autonomy_task_preparation_invalid" },
        );
      if (
        autonomyTasks.has(task.id) ||
        runs.has(run.id) ||
        autonomySteps.has(`${step.taskId}:${step.stepId}`)
      )
        throw Object.assign(
          new Error("The autonomy task preparation already exists."),
          { code: "autonomy_task_preparation_conflict" },
        );
      const activityLength = activity.length;
      const priorSequence = sequence;
      try {
        const preparedRun = await this.createRun(run);
        const preparedTask = await this.createAutonomyTask(task);
        const preparedStep = await this.recordAutonomyStep(step);
        const preparedActivity = await this.appendActivity(initialActivity);
        return {
          task: preparedTask,
          run: preparedRun,
          step: preparedStep,
          activity: preparedActivity,
        };
      } catch (error) {
        autonomySteps.delete(`${step.taskId}:${step.stepId}`);
        autonomyTasks.delete(task.id);
        runs.delete(run.id);
        activity.splice(activityLength);
        sequence = priorSequence;
        throw error;
      }
    },
    async getAutonomyTask(id, ownerId) {
      const task = autonomyTasks.get(id);
      return copy(task?.ownerId === ownerId ? task : null);
    },
    async createRejectedReviewEvidence({ownerId,taskId,envelope}) {
      const task=autonomyTasks.get(taskId);
      if(!validateRejectedReviewEvidenceEnvelope(envelope)||envelope.taskId!==taskId||task?.ownerId!==ownerId)throw new Error("Invalid private rejection evidence binding.");
      const key=JSON.stringify([ownerId,taskId,envelope.executionId,envelope.attempt,envelope.continuationGenerationId]);
      const existing=rejectedReviewEvidence.get(key);
      if(existing)return copy(existing);
      const record={id:randomUUID(),ownerId,taskId,createdAt:now(clock),envelope:copy(envelope)};
      rejectedReviewEvidence.set(key,record);return copy(record);
    },
    async getRejectedReviewEvidence(id,ownerId,taskId) {
      if(autonomyTasks.get(taskId)?.ownerId!==ownerId)return null;
      return copy([...rejectedReviewEvidence.values()].find(item=>item.id===id&&item.ownerId===ownerId&&item.taskId===taskId)||null);
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
      // Cancellation is a terminal fence against stale claimed-worker writes.
      if (current.status === "cancelled") return null;
      if (
        patch.maxSteps !== undefined &&
        (!Number.isInteger(patch.maxSteps) ||
          patch.maxSteps < 1 ||
          patch.maxSteps > 100)
      )
        throw Object.assign(new Error("A bounded integer maxSteps is required."), {
          code: "invalid_max_steps",
        });
      const updated = {
        ...current,
        ...copy(patch),
        ...(patch.maxSteps === undefined
          ? {}
          : { maxSteps: Math.max(current.maxSteps, patch.maxSteps) }),
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
        const recoveryKey=input.recoveryMetadataKey||"postAttestationRecovery",recovery={previousStatus:"expired",previousErrorCode:"max_runtime_reached",previousStartedAt:input.previousStartedAt,previousCompletedAt:input.previousCompletedAt,recoveredAt:now(clock)},recovered={...current,status:"queued",currentStep:input.resumeStep??9,currentPhase:"post_attestation_recovery",maxSteps:Math.max(current.maxSteps,input.plan.length+1),maxRuntimeMinutes:input.runtimeMinutes,startedAt:now(clock),completedAt:null,nextRunAt:now(clock),blockedReason:null,errorCode:null,metadata:{...current.metadata,steps:copy(input.plan),requiredCapability:input.requiredCapability||"vercel_preview",[recoveryKey]:recovery},stateVersion:current.stateVersion+1,updatedAt:now(clock)};
        autonomyTasks.set(input.taskId,recovered);await this.appendActivity({ownerId:input.ownerId,projectId:current.projectId,runId:current.id,action:input.activityAction||"autonomy_post_attestation_expiry_recovered",status:"completed",summary:input.activitySummary||"Recovered the exact expired post-attestation verification continuation.",metadata:{taskId:current.id,previousStatus:"expired",previousErrorCode:"max_runtime_reached",newRuntimeMinutes:input.runtimeMinutes,actorType:input.actorType,expectedVersion:input.expectedVersion,newVersion:input.expectedVersion+1,result:"completed"}});return copy(recovered);
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
      claimMetadata,
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
      eligible.metadata = { ...eligible.metadata, ...copy(claimMetadata || {}), claimKey: idempotencyKey };
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
    async createExecutionAttempt(input) {
      const task=autonomyTasks.get(input.taskId);if(!task||task.ownerId!==input.ownerId)return null;
      const existing=[...executionAttempts.values()].find(item=>item.taskId===input.taskId&&["preparing","executing"].includes(item.status));
      if(existing)return existing.handoffId===input.handoffId&&existing.workerId===input.workerId?copy(existing):null;
      const generation=Math.max(0,...[...executionAttempts.values()].filter(item=>item.taskId===input.taskId).map(item=>item.generation||0))+1,timestamp=now(clock),attempt={id:input.id,taskId:input.taskId,ownerId:input.ownerId,handoffId:input.handoffId,workerId:input.workerId,generation,fenceToken:input.fenceToken,status:input.status||"preparing",phase:input.phase||"preparing",executorStarted:false,claimedAt:timestamp,lastHeartbeatAt:timestamp,lastProgressAt:null,leaseExpiresAt:new Date(clock().getTime()+input.leaseMs).toISOString(),endedAt:null,terminalReason:null,metadata:copy(input.metadata||{})};executionAttempts.set(attempt.id,attempt);return copy(attempt);
    },
    async getActiveExecutionAttempt(taskId,ownerId){return copy([...executionAttempts.values()].filter(item=>item.taskId===taskId&&item.ownerId===ownerId&&["preparing","executing"].includes(item.status)).sort((a,b)=>b.generation-a.generation)[0]||null);},
    async getLatestExecutionAttempt(taskId,ownerId){return copy([...executionAttempts.values()].filter(item=>item.taskId===taskId&&item.ownerId===ownerId).sort((a,b)=>b.generation-a.generation)[0]||null);},
    async listActiveExecutionAttempts(ownerId){return [...executionAttempts.values()].filter(item=>item.ownerId===ownerId&&["preparing","executing"].includes(item.status)).map(copy);},
    async heartbeatExecutionAttempt(input){const item=executionAttempts.get(input.id),timestamp=clock();if(!item||item.ownerId!==input.ownerId||item.taskId!==input.taskId||item.handoffId!==input.handoffId||item.workerId!==input.workerId||item.generation!==input.generation||item.fenceToken!==input.fenceToken||!["preparing","executing"].includes(item.status)||new Date(item.leaseExpiresAt)<=timestamp)return null;item.status=input.executorStarted||item.executorStarted?"executing":"preparing";item.executorStarted=item.executorStarted||input.executorStarted===true;if(input.phase)item.phase=input.phase;item.lastHeartbeatAt=timestamp.toISOString();if(input.progress)item.lastProgressAt=timestamp.toISOString();item.leaseExpiresAt=new Date(timestamp.getTime()+input.leaseMs).toISOString();return copy(item);},
    async finishExecutionAttempt(input){const item=executionAttempts.get(input.id);if(!item||item.ownerId!==input.ownerId||item.taskId!==input.taskId||item.handoffId!==input.handoffId||item.workerId!==input.workerId||item.generation!==input.generation||item.fenceToken!==input.fenceToken||!["preparing","executing"].includes(item.status))return null;item.status=input.status;item.terminalReason=input.reason||null;item.endedAt=now(clock);item.leaseExpiresAt=item.endedAt;return copy(item);},
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
    async saveGmailOAuthState(input) {
      for (const [key, state] of gmailOAuthStates)
        if (state.consumedAt || new Date(state.expiresAt) <= clock()) gmailOAuthStates.delete(key);
      const record = { ...copy(input), consumedAt: null, createdAt: now(clock) };
      gmailOAuthStates.set(record.stateHash, record);
      return copy(record);
    },
    async consumeGmailOAuthState({ stateHash, ownerId, sessionHash, consumedAt }) {
      const current = gmailOAuthStates.get(stateHash);
      if (!current || current.ownerId !== ownerId || current.sessionHash !== sessionHash || current.consumedAt || new Date(current.expiresAt) <= new Date(consumedAt)) return null;
      const updated = { ...current, consumedAt };
      gmailOAuthStates.set(stateHash, updated);
      return copy(updated);
    },
    async saveGmailConnection(input) {
      const current = gmailConnections.get(input.ownerId);
      const timestamp = now(clock);
      const saved = { ...copy(input), connectedAt: current?.connectedAt || timestamp, updatedAt: timestamp };
      gmailConnections.set(input.ownerId, saved);
      return copy(saved);
    },
    async getGmailConnection(ownerId) {
      return copy(gmailConnections.get(ownerId) || null);
    },
    async deleteGmailConnection(ownerId) {
      const current = gmailConnections.get(ownerId);
      if (!current) return null;
      gmailConnections.delete(ownerId);
      return copy(current);
    },
    async createGmailDraft(input) {
      const saved = { ...copy(input), createdAt: now(clock) };
      gmailDrafts.set(saved.id, saved);
      return copy(saved);
    },
    async getGmailDraft(id, ownerId) {
      const draft = gmailDrafts.get(id);
      return copy(draft?.ownerId === ownerId ? draft : null);
    },
    async getSpeakerChannelCalibration(ownerId, channel) {
      return copy([...speakerChannelCalibrations.values()].find((item) => item.ownerId === ownerId && item.channel === channel && item.status !== "revoked") || null);
    },
    async saveSpeakerChannelCalibration(input) {
      const key = `${input.ownerId}:${input.speakerProfileId}:${input.channel}`, current = speakerChannelCalibrations.get(key), timestamp = now(clock);
      const value = { ...copy(current || {}), ...copy(input), createdAt: current?.createdAt || timestamp, updatedAt: timestamp };
      speakerChannelCalibrations.set(key, value); return copy(value);
    },
    async saveSpeakerEnrollmentConsent(input) {
      const active=[...speakerEnrollmentConsents.values()].find(item=>item.ownerId===input.ownerId&&item.purpose===input.purpose&&item.channel===input.channel&&item.status==="active");
      if(active)return copy(active);
      const timestamp=now(clock),record={...copy(input),status:"active",createdAt:timestamp,updatedAt:timestamp,revokedAt:null};speakerEnrollmentConsents.set(record.id,record);return copy(record);
    },
    async getActiveSpeakerEnrollmentConsent(ownerId,{purpose,channel}) { return copy([...speakerEnrollmentConsents.values()].find(item=>item.ownerId===ownerId&&item.purpose===purpose&&item.channel===channel&&item.status==="active")||null); },
    async revokeSpeakerEnrollmentConsent(id,ownerId,revokedAt) { const record=speakerEnrollmentConsents.get(id);if(!record||record.ownerId!==ownerId)return null;const updated={...record,status:"revoked",revokedAt,updatedAt:now(clock)};speakerEnrollmentConsents.set(id,updated);const ids=[];for(const session of speakerEnrollmentSessions.values())if(session.ownerId===ownerId&&session.consentId===id){ids.push(session.id);if(!['failed','revoked'].includes(session.status)){session.status='revoked';session.updatedAt=now(clock);}}for(const sample of speakerEnrollmentSamples.values())if(sample.ownerId===ownerId&&ids.includes(sample.sessionId))sample.encryptedRepresentation=null;return copy(updated); },
    async createSpeakerEnrollmentSession(input) { const timestamp=now(clock),record={...copy(input),status:input.status||"prepared",acceptedCount:0,totalRequired:6,callIntentId:null,approvalId:null,completedAt:null,createdAt:timestamp,updatedAt:timestamp};speakerEnrollmentSessions.set(record.id,record);return copy(record); },
    async getSpeakerEnrollmentSession(id,ownerId) { const record=speakerEnrollmentSessions.get(id);return copy(record?.ownerId===ownerId?record:null); },
    async listSpeakerEnrollmentSessions(ownerId,{limit=20}={}) { return [...speakerEnrollmentSessions.values()].filter(item=>item.ownerId===ownerId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit).map(copy); },
    async updateSpeakerEnrollmentSession(id,ownerId,patch) { const record=speakerEnrollmentSessions.get(id);if(!record||record.ownerId!==ownerId)return null;const updated={...record,...copy(patch),id:record.id,ownerId:record.ownerId,consentId:record.consentId,conversationId:record.conversationId,phrasePlan:record.phrasePlan,updatedAt:now(clock)};speakerEnrollmentSessions.set(id,updated);return copy(updated); },
    async recordSpeakerEnrollmentSample(input) { const existing=[...speakerEnrollmentSamples.values()].find(item=>item.ownerId===input.ownerId&&item.sessionId===input.sessionId&&item.submissionKey===input.submissionKey);if(existing)return{inserted:false,sample:copy(existing)};const sample={...copy(input),createdAt:now(clock)};speakerEnrollmentSamples.set(sample.id,sample);if(sample.status==="accepted"){const session=speakerEnrollmentSessions.get(sample.sessionId);if(session&&session.ownerId===input.ownerId){session.acceptedCount=Math.min(3,session.acceptedCount+1);session.updatedAt=now(clock);}}return{inserted:true,sample:copy(sample)}; },
    async listSpeakerEnrollmentSamples(ownerId,sessionId,{includeRepresentation=false}={}) { return [...speakerEnrollmentSamples.values()].filter(item=>item.ownerId===ownerId&&item.sessionId===sessionId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(item=>{const value=copy(item);if(!includeRepresentation)delete value.encryptedRepresentation;return value;}); },
    async purgeSpeakerEnrollmentSampleRepresentations(ownerId,sessionIds) { let count=0;for(const sample of speakerEnrollmentSamples.values())if(sample.ownerId===ownerId&&sessionIds.includes(sample.sessionId)&&sample.encryptedRepresentation){sample.encryptedRepresentation=null;count++;}return count; },
    async createSpeakerControlSession(input) { const timestamp=now(clock),record={...copy(input),consentStatus:"pending",status:input.status||"prepared",acceptedCount:0,callIntentId:null,approvalId:null,consentedAt:null,refusedAt:null,completedAt:null,createdAt:timestamp,updatedAt:timestamp};speakerControlSessions.set(record.id,record);return copy(record); },
    async getSpeakerControlSession(id,ownerId) { const record=speakerControlSessions.get(id);return copy(record?.ownerId===ownerId?record:null); },
    async listSpeakerControlSessions(ownerId,{limit=20}={}) { return [...speakerControlSessions.values()].filter(item=>item.ownerId===ownerId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit).map(copy); },
    async updateSpeakerControlSession(id,ownerId,patch) { const record=speakerControlSessions.get(id);if(!record||record.ownerId!==ownerId)return null;const updated={...record,...copy(patch),id:record.id,ownerId:record.ownerId,participantCode:record.participantCode,conversationId:record.conversationId,plan:record.plan,consentVersion:record.consentVersion,consentDisclosure:record.consentDisclosure,updatedAt:now(clock)};speakerControlSessions.set(id,updated);return copy(updated); },
    async recordSpeakerControlSample(input) { const existing=[...speakerControlSamples.values()].find(item=>item.ownerId===input.ownerId&&item.sessionId===input.sessionId&&(item.submissionKey===input.submissionKey||(input.status==="accepted"&&item.status==="accepted"&&item.ordinal===input.ordinal)));if(existing)return{inserted:false,sample:copy(existing)};const sample={...copy(input),createdAt:now(clock)};speakerControlSamples.set(sample.id,sample);if(sample.status==="accepted"){const session=speakerControlSessions.get(sample.sessionId);if(session&&session.ownerId===input.ownerId){session.acceptedCount=Math.min(4,session.acceptedCount+1);session.updatedAt=now(clock);}}return{inserted:true,sample:copy(sample)}; },
    async listSpeakerControlSamples(ownerId,sessionId) { return [...speakerControlSamples.values()].filter(item=>item.ownerId===ownerId&&item.sessionId===sessionId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(copy); },
    async listConversationGmailDrafts(ownerId, conversationId, { limit = 2 } = {}) {
      const seen = new Set();
      return activity
        .filter((event) => event.ownerId === ownerId && event.action === "gmail_draft_prepared" && ["gmail_draft_prepare", "gmail_reply_draft_prepare"].includes(event.tool) && event.status === "completed")
        .sort((left, right) => right.sequence - left.sequence)
        .flatMap((event) => {
          const run = runs.get(event.runId), draftId = event.metadata?.draftId, draft = gmailDrafts.get(draftId);
          if (run?.ownerId !== ownerId || run.conversationId !== conversationId || draft?.ownerId !== ownerId || seen.has(draftId)) return [];
          seen.add(draftId); return [draft];
        })
        .slice(0, limit)
        .map(copy);
    },
    async claimWhatsAppInbound(input) {
      const existing = whatsappInboundMessages.get(input.messageSid);
      if (existing) return { claimed: false, message: copy(existing) };
      const timestamp = now(clock), message = { ...copy(input), status: "queued", attemptCount: 0, nextAttemptAt: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, runId: null, assistantMessageId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp };
      whatsappInboundMessages.set(message.messageSid, message);
      return { claimed: true, message: copy(message) };
    },
    async updateWhatsAppInbound(messageSid, ownerId, patch) {
      const current = whatsappInboundMessages.get(messageSid);
      if (!current || current.ownerId !== ownerId) return null;
      const updated = { ...current, ...copy(patch), messageSid: current.messageSid, ownerId: current.ownerId, conversationId: current.conversationId, contactId: current.contactId, bodyHash: current.bodyHash, updatedAt: now(clock) };
      whatsappInboundMessages.set(messageSid, updated); return copy(updated);
    },
    async claimNextWhatsAppInbound({ ownerId, workerId, leaseMs }) {
      const timestamp=clock();
      for(const message of whatsappInboundMessages.values())if(message.ownerId===ownerId&&message.status==="processing"&&new Date(message.leaseExpiresAt)<=timestamp){message.status="queued";message.leaseOwner=null;message.leaseToken=null;message.leaseExpiresAt=null;}
      const message=[...whatsappInboundMessages.values()].filter(item=>item.ownerId===ownerId&&item.status==="queued"&&(!item.nextAttemptAt||new Date(item.nextAttemptAt)<=timestamp)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.messageSid.localeCompare(b.messageSid))[0];
      if(!message)return null;message.status="processing";message.attemptCount+=1;message.leaseOwner=workerId;message.leaseToken=randomUUID();message.leaseExpiresAt=new Date(timestamp.getTime()+leaseMs).toISOString();message.updatedAt=now(clock);return copy(message);
    },
    async renewWhatsAppInboundLease(input) {
      const current=whatsappInboundMessages.get(input.messageSid),timestamp=clock();
      if(!current||current.ownerId!==input.ownerId||current.status!=="processing"||current.leaseOwner!==input.workerId||current.leaseToken!==input.leaseToken||new Date(current.leaseExpiresAt)<=timestamp)return null;
      current.leaseExpiresAt=new Date(timestamp.getTime()+input.leaseMs).toISOString();current.updatedAt=now(clock);return copy(current);
    },
    async checkpointWhatsAppInbound(input) {
      const current=whatsappInboundMessages.get(input.messageSid),timestamp=clock();
      if(!current||current.ownerId!==input.ownerId||current.status!=="processing"||current.leaseOwner!==input.workerId||current.leaseToken!==input.leaseToken||new Date(current.leaseExpiresAt)<=timestamp)return null;
      current.runId=input.runId||null;current.assistantMessageId=input.assistantMessageId;current.updatedAt=now(clock);return copy(current);
    },
    async finishWhatsAppInbound(input) {
      const current=whatsappInboundMessages.get(input.messageSid),timestamp=clock();
      if(!current||current.ownerId!==input.ownerId||current.status!=="processing"||current.leaseOwner!==input.workerId||current.leaseToken!==input.leaseToken||new Date(current.leaseExpiresAt)<=timestamp)return null;
      const updated={...current,status:input.status,runId:input.runId??current.runId,assistantMessageId:input.assistantMessageId??current.assistantMessageId,errorCode:input.errorCode??null,nextAttemptAt:input.nextAttemptAt||null,leaseOwner:null,leaseToken:null,leaseExpiresAt:null,updatedAt:now(clock)};whatsappInboundMessages.set(input.messageSid,updated);return copy(updated);
    },
    async claimWhatsAppOutbound(input) {
      const existing = whatsappOutboundMessages.get(input.inboundSid);
      if (existing) return { claimed: false, message: copy(existing) };
      const timestamp = now(clock), message = { ...copy(input), status: "sending", providerMessageSid: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp };
      whatsappOutboundMessages.set(message.inboundSid, message);
      return { claimed: true, message: copy(message) };
    },
    async updateWhatsAppOutbound(inboundSid, ownerId, patch) {
      const current = whatsappOutboundMessages.get(inboundSid);
      if (!current || current.ownerId !== ownerId) return null;
      const updated = { ...current, ...copy(patch), inboundSid: current.inboundSid, ownerId: current.ownerId, bodyHash: current.bodyHash, updatedAt: now(clock) };
      whatsappOutboundMessages.set(inboundSid, updated); return copy(updated);
    },
    async updateWhatsAppOutboundByProviderSid(providerMessageSid, ownerId, patch) {
      const current = [...whatsappOutboundMessages.values()].find((item) => item.ownerId === ownerId && item.providerMessageSid === providerMessageSid);
      if(!current)return null;const rank={submitted:0,queued:0,sent:1,delivered:2,read:3},terminal=new Set(["failed","undelivered"]),next=patch.status;
      if(terminal.has(current.status)||(!terminal.has(next)&&(rank[next]??-1)<(rank[current.status]??-1)))return copy(current);
      return this.updateWhatsAppOutbound(current.inboundSid, ownerId, patch);
    },
    async getWhatsAppInbound(messageSid, ownerId) { const value = whatsappInboundMessages.get(messageSid); return copy(value?.ownerId === ownerId ? value : null); },
    async getWhatsAppOutbound(inboundSid, ownerId) { const value = whatsappOutboundMessages.get(inboundSid); return copy(value?.ownerId === ownerId ? value : null); },
    async createProject(input) {
      if(projects.has(input.id))throw Object.assign(new Error("Project already exists."),{code:"project_conflict"});
      const timestamp=now(clock),project={id:input.id,ownerId:input.ownerId,name:input.name,description:input.description||null,createdAt:timestamp,updatedAt:timestamp};
      projects.set(project.id,project);return copy(project);
    },
    async claimGmailSendIntent(input) {
      const existing = gmailSendIntents.get(input.id) || [...gmailSendIntents.values()].find((item) => item.ownerId === input.ownerId && item.draftId === input.draftId);
      if (existing) return { inserted: false, intent: copy(existing) };
      const timestamp = now(clock);
      const intent = { ...copy(input), status: "sending", providerMessageId: null, providerThreadId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp };
      gmailSendIntents.set(intent.id, intent);
      return { inserted: true, intent: copy(intent) };
    },
    async updateGmailSendIntent(id, ownerId, patch) {
      const current = gmailSendIntents.get(id);
      if (!current || current.ownerId !== ownerId) return null;
      const updated = { ...current, ...copy(patch), updatedAt: now(clock) };
      gmailSendIntents.set(id, updated);
      return copy(updated);
    },
    async createPhoneCallIntent(input) {
      if (phoneCallIntents.has(input.id)) throw Object.assign(new Error("Phone call intent already exists."), { code: "23505" });
      const timestamp = now(clock);
      const call = { ...copy(input), status: "prepared", approvalId: null, attemptCount: 0, submissionKey: null, providerCallSid: null, providerStreamSid: null, providerStatus: null, sessionTokenHash: null, sessionTokenExpiresAt: null, sessionTokenUsedAt: null, outcome: null, summary: null, errorCode: null, startedAt: null, endedAt: null, createdAt: timestamp, updatedAt: timestamp };
      phoneCallIntents.set(call.id, call);
      return copy(call);
    },
    async getPhoneCallIntent(id, ownerId) { const call = phoneCallIntents.get(id); return copy(call?.ownerId === ownerId ? call : null); },
    async listConversationPhoneCalls(ownerId, conversationId, { limit = 20 } = {}) {
      return [...phoneCallIntents.values()].filter((call) => call.ownerId === ownerId && (call.conversationId === conversationId || call.callConversationId === conversationId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)).slice(0, limit).map((call) => {
        const run = runs.get(call.preparedRunId);
        return copy({ ...call, ...(run?.result?.assistantMessageId ? { assistantMessageId: run.result.assistantMessageId } : {}) });
      });
    },
    async listPhoneCalls(ownerId, { limit = 50 } = {}) {
      return [...phoneCallIntents.values()].filter((call) => call.ownerId === ownerId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)).slice(0, limit).map(copy);
    },
    async getOwnerContactPolicy(ownerId) { return copy(ownerContactPolicies.get(ownerId) || null); },
    async saveOwnerContactPolicy(input) {
      const current = ownerContactPolicies.get(input.ownerId); const timestamp = now(clock);
      const value = { ...copy(current || {}), ...copy(input), createdAt: current?.createdAt || timestamp, updatedAt: timestamp };
      ownerContactPolicies.set(input.ownerId, value); return copy(value);
    },
    async consumeOwnerContactPolicy(ownerId, version, consumedAt) {
      const current = ownerContactPolicies.get(ownerId);
      if (!current || !current.enabled || current.version !== version || current.pausedAt || current.revokedAt || new Date(current.expiresAt) <= new Date(consumedAt) || current.usedCalls >= current.maximumCalls || current.usedCalls >= current.dailyLimit) return null;
      const value = { ...current, usedCalls: current.usedCalls + 1, updatedAt: now(clock) }; ownerContactPolicies.set(ownerId, value); return copy(value);
    },
    async recordOwnerCallbackEligibility(input) {
      const key = `${input.ownerId}:${input.taskId}:${input.terminalStateVersion}`;
      const existing = ownerCallbackEligibilities.get(key);
      if (existing) return { inserted: false, eligibility: copy(existing) };
      const task = autonomyTasks.get(input.taskId);
      if (!task || task.ownerId !== input.ownerId) return null;
      const value = { ...copy(input), createdAt: now(clock) };
      ownerCallbackEligibilities.set(key, value);
      return { inserted: true, eligibility: copy(value) };
    },
    async listOwnerCallbackEligibilityCandidates(ownerId, { limit = 100 } = {}) {
      const recorded = new Set([...ownerCallbackEligibilities.values()].map((item) => `${item.taskId}:${item.terminalStateVersion}`));
      return [...autonomyTasks.values()].filter((task) => task.ownerId === ownerId && ["completed", "blocked"].includes(task.status) && task.metadata?.terminalReporting?.version === 1 && !recorded.has(`${task.id}:${task.stateVersion}`)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, limit).map(copy);
    },
    async listOwnerCallbackEligibilities(ownerId, { limit = 100 } = {}) {
      return [...ownerCallbackEligibilities.values()].filter((item) => item.ownerId === ownerId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.taskId.localeCompare(right.taskId)).slice(0, limit).map(copy);
    },
    async bindPhoneCallApproval(id, ownerId, { approvalId, status }) {
      const call = phoneCallIntents.get(id);
      if (!call || call.ownerId !== ownerId || !["prepared", "waiting_for_approval"].includes(call.status) || (call.approvalId && call.approvalId !== approvalId)) return null;
      const updated = { ...call, approvalId, status, updatedAt: now(clock) }; phoneCallIntents.set(id, updated); return copy(updated);
    },
    async approvePhoneCallIntent(id, ownerId, { approvalId }) {
      const call = phoneCallIntents.get(id);
      if (!call || call.ownerId !== ownerId || call.approvalId !== approvalId || !["waiting_for_approval", "approved", "dialing", "in_progress", "completed", "failed", "uncertain"].includes(call.status)) return null;
      if (call.status !== "waiting_for_approval") return copy(call);
      const updated = { ...call, status: "approved", updatedAt: now(clock) }; phoneCallIntents.set(id, updated); return copy(updated);
    },
    async authorizePhoneCallByPolicy(id, ownerId, { policyVersion }) {
      const call = phoneCallIntents.get(id);
      if (!call || call.ownerId !== ownerId || call.status !== "prepared" || call.envelope?.ownerContactPolicyVersion !== policyVersion) return null;
      const updated = { ...call, status: "approved", updatedAt: now(clock) }; phoneCallIntents.set(id, updated); return copy(updated);
    },
    async updatePhoneCallIntent(id, ownerId, patch) {
      const call = phoneCallIntents.get(id); if (!call || call.ownerId !== ownerId) return null;
      const updated = { ...call, ...copy(patch), id: call.id, ownerId: call.ownerId, conversationId: call.conversationId, envelope: call.envelope, envelopeHash: call.envelopeHash, attemptCount: call.attemptCount, updatedAt: now(clock) };
      phoneCallIntents.set(id, updated); return copy(updated);
    },
    async bindPhoneProviderCallSid(id, ownerId, { callSid, providerStatus }) {
      const call=phoneCallIntents.get(id); if(!call||call.ownerId!==ownerId||(call.providerCallSid&&call.providerCallSid!==callSid))return null;
      const updated={...call,providerCallSid:callSid,providerStatus,updatedAt:now(clock)};phoneCallIntents.set(id,updated);return copy(updated);
    },
    async savePhoneSessionToken(id, ownerId, { tokenHash, expiresAt }) {
      const call = phoneCallIntents.get(id); if (!call || call.ownerId !== ownerId || call.sessionTokenUsedAt) return null;
      const updated = { ...call, sessionTokenHash: tokenHash, sessionTokenExpiresAt: expiresAt, updatedAt: now(clock) }; phoneCallIntents.set(id, updated); return copy(updated);
    },
    async claimPhoneCallDial({ id, ownerId, approvalId, policyVersion, submissionKey, tokenHash, tokenExpiresAt }) {
      const call = phoneCallIntents.get(id);
      if (!call || call.ownerId !== ownerId) return null;
      const authorityMatches = approvalId ? call.approvalId === approvalId : policyVersion && call.envelope?.ownerContactPolicyVersion === policyVersion;
      if (call.status !== "approved" || !authorityMatches || call.attemptCount >= call.envelope.maximumAttempts) return { claimed: false, call: copy(call) };
      const active = [...phoneCallIntents.values()].some((candidate) => candidate.ownerId === ownerId && candidate.id !== id && ["dialing", "in_progress"].includes(candidate.status));
      if (active) return { claimed: false, call: copy(call), reason: "active_call" };
      const updated = { ...call, status: "dialing", attemptCount: call.attemptCount + 1, submissionKey, sessionTokenHash: tokenHash, sessionTokenExpiresAt: tokenExpiresAt, sessionTokenUsedAt: null, updatedAt: now(clock) }; phoneCallIntents.set(id, updated); return { claimed: true, call: copy(updated) };
    },
    async consumePhoneSessionToken(id, ownerId, { tokenHash, callSid, streamSid, consumedAt }) {
      const call = phoneCallIntents.get(id);
      if (!call || call.ownerId !== ownerId || !["dialing","in_progress"].includes(call.status) || call.sessionTokenHash !== tokenHash || call.sessionTokenUsedAt || new Date(call.sessionTokenExpiresAt) <= new Date(consumedAt) || (call.providerCallSid && call.providerCallSid !== callSid) || (call.providerStreamSid && call.providerStreamSid !== streamSid)) return null;
      const updated = { ...call, providerCallSid: callSid, providerStreamSid: streamSid, sessionTokenUsedAt: consumedAt, status: "in_progress", startedAt: call.startedAt || consumedAt, updatedAt: now(clock) }; phoneCallIntents.set(id, updated); return copy(updated);
    },
    async appendPhoneCallEvent(input) {
      const existing = [...phoneCallEvents.values()].find((event) => event.ownerId === input.ownerId && event.callIntentId === input.callIntentId && event.eventKey === input.eventKey);
      if (existing) return { inserted: false, event: copy(existing) };
      const event = { ...copy(input), createdAt: now(clock) }; phoneCallEvents.set(event.id, event); return { inserted: true, event: copy(event) };
    },
    async claimPhoneCallTurn(input) {
      const existing = phoneCallTurns.get(input.id); if (existing) return { claimed: false, turn: copy(existing) };
      const timestamp = now(clock), turn = { ...copy(input), novaText: null, control: null, runId: null, status: "processing", errorCode: null, createdAt: timestamp, updatedAt: timestamp };
      phoneCallTurns.set(turn.id, turn); return { claimed: true, turn: copy(turn) };
    },
    async completePhoneCallTurn(id, ownerId, patch) {
      const turn = phoneCallTurns.get(id); if (!turn || turn.ownerId !== ownerId) return null;
      const updated = { ...turn, ...copy(patch), id: turn.id, ownerId: turn.ownerId, callIntentId: turn.callIntentId, inputHash: turn.inputHash, callerText: turn.callerText, updatedAt: now(clock) }; phoneCallTurns.set(id, updated); return copy(updated);
    },
    async listPhoneCallTurns(ownerId, callIntentId) { return [...phoneCallTurns.values()].filter((turn) => turn.ownerId === ownerId && turn.callIntentId === callIntentId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).map(copy); },
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
    async getApprovalIntentState(ownerId, { conversationId, tool, arguments: approvalArguments }) {
      const matching = [...approvals.values()].filter((approval) => {
        const run = runs.get(approval.runId);
        return approval.ownerId === ownerId && run?.ownerId === ownerId && run.conversationId === conversationId &&
          approval.tool === tool && sameJson(approval.arguments, approvalArguments || {});
      }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      return { pending: copy(matching.find((approval) => approval.status === "pending") || null), equivalentCount: matching.length };
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
    async listApprovals(ownerId, { status, conversationId, limit = 50 } = {}) {
      return [...approvals.values()]
        .filter(
          (item) => {
            const run = runs.get(item.runId);
            return item.ownerId === ownerId && (!status || item.status === status) &&
              (!conversationId || (run?.ownerId === ownerId && run.conversationId === conversationId));
          },
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map((approval) => {
          const run = runs.get(approval.runId);
          return copy({
            ...approval,
            ...(run?.conversationId ? { conversationId: run.conversationId } : {}),
            ...(run?.result?.assistantMessageId ? { assistantMessageId: run.result.assistantMessageId } : {}),
          });
        });
    },
    async listRunsForApproval(ownerId, approvalId) {
      return [...runs.values()]
        .filter((run) => run.ownerId === ownerId && run.result?.approvalId === approvalId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
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
    async saveDeveloperSession(record, ownerId) {
      const current = developerSessions.get(record.id);
      if (current && current.ownerId !== ownerId) return null;
      developerSessions.set(record.id, { ownerId, record: copy(record) });
      return copy(record);
    },
    async getDeveloperSession(id, ownerId) {
      const current = developerSessions.get(id);
      return copy(current?.ownerId === ownerId ? current.record : null);
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
    async getModelCostBudget(ownerId, budgetId) {
      return copy(modelCostBudgets.get(`${ownerId}:${budgetId}`) || null);
    },
    async reserveModelCost(input) {
      const key = `${input.ownerId}:${input.budgetId}`;
      const current = modelCostBudgets.get(key) || { ownerId: input.ownerId, budgetId: input.budgetId, spentNanoUsd: 0, reservedNanoUsd: 0, tasks: {} };
      const task = input.taskId ? current.tasks[input.taskId] || { spentNanoUsd: 0, reservedNanoUsd: 0 } : null;
      if (current.spentNanoUsd + current.reservedNanoUsd + input.reservedNanoUsd > input.globalCapNanoUsd) return null;
      if (task && task.spentNanoUsd + task.reservedNanoUsd + input.reservedNanoUsd > input.taskCapNanoUsd) return null;
      const updated = copy(current);
      updated.reservedNanoUsd += input.reservedNanoUsd;
      if (input.taskId) updated.tasks[input.taskId] = { ...task, reservedNanoUsd: task.reservedNanoUsd + input.reservedNanoUsd };
      modelCostBudgets.set(key, updated);
      const reservation = { ...copy(input), status: "reserved", actualNanoUsd: null, usage: null, createdAt: now(clock), settledAt: null };
      modelCostReservations.set(input.id, reservation);
      return copy(reservation);
    },
    async settleModelCost(id, ownerId, patch) {
      const reservation = modelCostReservations.get(id);
      if (!reservation || reservation.ownerId !== ownerId || reservation.status !== "reserved") return null;
      const key = `${ownerId}:${reservation.budgetId}`;
      const current = modelCostBudgets.get(key);
      if (!current) return null;
      const actual = Number(patch.actualNanoUsd || 0);
      current.reservedNanoUsd -= reservation.reservedNanoUsd;
      current.spentNanoUsd += actual;
      if (reservation.taskId) {
        const task = current.tasks[reservation.taskId] || { spentNanoUsd: 0, reservedNanoUsd: 0 };
        current.tasks[reservation.taskId] = { spentNanoUsd: task.spentNanoUsd + actual, reservedNanoUsd: task.reservedNanoUsd - reservation.reservedNanoUsd };
      }
      const updated = { ...reservation, status: patch.status, actualNanoUsd: actual, usage: copy(patch.usage), settledAt: now(clock) };
      modelCostReservations.set(id, updated);
      return copy(updated);
    },
  });
}

function sanitiseBenchmark(input) {
  const { audio, audioBase64, audioData, ...safe } = copy(input || {});
  return safe;
}
