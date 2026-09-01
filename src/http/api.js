import { readJsonBody } from "./body.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { AgentStepLimitError, AgentToolCallLimitError } from "../agent/agent.js";
import {
  ValidationError,
  validateAgentRequest,
  validateMissedCallRequest,
  validateOwnerProfilePatch,
  validateMemoryCreate,
  validateMemoryPatch,
  validateListLimit,
  validateListOffset,
  validateApprovalDecision
} from "./validation.js";
import { BenchmarkBudgetError, BenchmarkLockedError, BenchmarkUnavailableError, BenchmarkValidationError } from "../benchmark/service.js";
import { VoiceProviderError, VoiceTimeoutError, VoiceUnavailableError, VoiceValidationError } from "../voice/voice-service.js";

class StorageUnavailableError extends Error {}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.end(JSON.stringify(payload));
}

function setSpeechHeaders(response, model) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Nova-Voice-Model", model);
  response.setHeader("X-Nova-Voice-Protocol", "semantic-audio-stream-v1");
}

async function writeChunk(response, value) {
  if (response.write(value) !== false) return;
  await once(response, "drain");
}

function speechEvent(chunk) {
  return JSON.stringify({ type: "audio", index: chunk.index, chunkCount: chunk.chunkCount, mimeType: chunk.mimeType, audioBase64: chunk.audio.toString("base64") }) + "\n";
}

async function sendSpeechStream(response, stream, { logger, requestId }) {
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new VoiceProviderError("elevenlabs", "ElevenLabs returned empty audio.", undefined, "unknown");
  setSpeechHeaders(response, first.value.model);
  response.flushHeaders?.();
  try {
    await writeChunk(response, speechEvent(first.value));
    while (true) {
      const item = await iterator.next();
      if (item.done) break;
      await writeChunk(response, speechEvent(item.value));
    }
    await writeChunk(response, JSON.stringify({ type: "end" }) + "\n");
    response.end();
  } catch (error) {
    const log = error?.category === "client_cancelled" ? logger.info.bind(logger) : logger.error.bind(logger);
    log("Nova voice stream failed", { requestId, service: error?.service, upstreamStatus: error?.upstreamStatus, category: error?.category || "unknown", providerCode: error?.providerCode, detail: error?.safeDetail });
    if (!response.writableEnded && !response.destroyed) {
      await writeChunk(response, JSON.stringify({ type: "error", code: error?.code || "VOICE_PROVIDER_ERROR", category: error?.category || "unknown" }) + "\n").catch(() => {});
      response.end();
    }
  }
}

function setCorsHeaders(request, response, allowedOrigins) {
  const origin = request.headers?.origin;

  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

export function createApi({ agent, config, storage, initialize, ownerId, toolRegistry = agent?.tools, voiceBenchmark, voiceService, speakerIdentity, speakerExtractor, speakerAssertions, logger = console }) {
  return Object.freeze({
    async handle(request, response) {
      const requestId = randomUUID();
      response.setHeader("X-Request-Id", requestId);
      setCorsHeaders(request, response, config.allowedOrigins);

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.end();
        return;
      }

      const url = new URL(request.url || "/", "http://localhost");
      const pathname = url.pathname;

      const ready = async () => {
        try { await initialize(); }
        catch { throw new StorageUnavailableError("Storage is unavailable."); }
      };

      try {
        if (request.method === "GET" && pathname === "/api/health") {
          let storageHealth;
          try { await ready(); storageHealth = await storage.health(); }
          catch { storageHealth = { provider: storage.provider, durable: storage.durable, status: "degraded" }; }
          sendJson(response, 200, {
            name: "Nova Brain",
            status: "online",
            provider: config.modelProvider,
            storage: storageHealth
          });
          return;
        }

        if (request.method === "POST" && pathname === "/api/agent") {
          await ready();
          const input = validateAgentRequest(
            await readJsonBody(request, config.maxBodyBytes)
          );
          const result = await agent.run(input);
          logger.info("Nova agent timing",{requestId,conversationId:result.conversationId,runId:result.runId,contextRetrievalMs:result.timing?.contextRetrievalMs,agentFirstResponseMs:result.timing?.agentFirstResponseMs,agentCompleteMs:result.timing?.agentCompleteMs,totalMs:result.timing?.totalMs});
          sendJson(response, 200, result);
          return;
        }

        if (request.method === "GET" && pathname === "/api/voice/readiness") {
          const [readiness, speaker] = await Promise.all([voiceService.readiness(), speakerExtractor?.readiness?.() || Promise.resolve({ status: "Missing", available: false })]);
          logger.info("Nova voice readiness", {
            available: readiness.available,
            sttStatus: readiness.stt?.status,
            ttsStatus: readiness.tts?.status,
            model: readiness.tts?.model,
            fallbackUsed: readiness.tts?.fallbackUsed,
            errorCategory: readiness.tts?.errorCategory
          });
          sendJson(response, 200, { ...readiness, speakerRecognition: speaker }); return;
        }
        if (request.method === "POST" && pathname === "/api/voice/transcribe") {
          const input = await readJsonBody(request, config.voiceV2.maxBodyBytes); const startedAt = Date.now();
          const [transcription, extracted] = await Promise.allSettled([voiceService.transcribe(input), speakerExtractor?.extract?.(input) || Promise.reject(new Error("not configured"))]);
          if (transcription.status === "rejected") throw transcription.reason;
          let speaker = { speaker_profile_id: null, speaker_label: "unknown", confidence: 0, extractor_version: config.speakerRecognition.modelVersion, match_status: "unknown" };
          let speakerRecognitionMs;
          if (extracted.status === "fulfilled") {
            speakerRecognitionMs = extracted.value.latencyMs;
            if (extracted.value.sufficient) {
              const match = await speakerIdentity.recognize(extracted.value.representation);
              speaker = match.state === "confirmed"
                ? { speaker_profile_id: match.speakerProfileId, speaker_label: match.relation === "owner" ? "owner" : "enrolled_member", confidence: match.confidence, extractor_version: extracted.value.extractorVersion, match_status: "confirmed" }
                : { ...speaker, extractor_version: extracted.value.extractorVersion, match_status: "unknown" };
            } else speaker.match_status = "insufficient_speech";
          }
          speaker.assertion = speakerAssertions?.issue?.(speaker) || null;
          if(speaker.match_status==="confirmed"&&!speaker.assertion)speaker={speaker_profile_id:null,speaker_label:"unknown",confidence:0,extractor_version:speaker.extractor_version,match_status:"unknown",assertion:null};
          sendJson(response, 200, { ...transcription.value, speaker, timing: { sttAndSpeakerMs: Date.now() - startedAt, ...(Number.isFinite(speakerRecognitionMs) ? { speakerRecognitionMs } : {}) } }); return;
        }
        if (request.method === "POST" && pathname === "/api/voice/speech") {
          const controller = new AbortController();
          const abort = () => controller.abort();
          request.once?.("aborted", abort);
          response.once?.("close", () => { if (!response.writableEnded) abort(); });
          const events = (event) => logger.info("Nova voice speech timing", { requestId, ...event });
          const stream = voiceService.streamSpeech(await readJsonBody(request, config.maxBodyBytes), { signal: controller.signal, onEvent: events });
          await sendSpeechStream(response, stream, { logger, requestId }); return;
        }

        if(request.method==="GET"&&pathname==="/api/speakers"){
          await ready();sendJson(response,200,{speakers:await speakerIdentity.list()});return;
        }
        if(request.method==="POST"&&pathname==="/api/speakers/enroll"){
          await ready();const input=await readJsonBody(request,config.voiceV2.maxBodyBytes);
          if(input?.consent!==true)throw new Error("Explicit speaker consent is required.");
          if(!Array.isArray(input.samples)||input.samples.length<3)throw new Error("At least three consented voice samples are required.");
          const extracted=await Promise.all(input.samples.map((sample)=>speakerExtractor.extract(sample)));
          if(extracted.some((item)=>!item.sufficient))throw new Error("Each enrollment sample must contain at least one second of speech.");
          const versions=new Set(extracted.map((item)=>item.extractorVersion));if(versions.size!==1)throw new Error("Enrollment samples must use one extractor version.");
          sendJson(response,201,{speaker:await speakerIdentity.enroll({...input,samples:undefined,sampleRepresentations:extracted.map((item)=>item.representation),representationVersion:extracted[0].extractorVersion})});return;
        }
        const speakerMatch=pathname.match(/^\/api\/speakers\/([^/]+)$/);
        if(speakerMatch&&request.method==="PATCH"){
          await ready();const speaker=await speakerIdentity.update(decodeURIComponent(speakerMatch[1]),await readJsonBody(request,config.maxBodyBytes));sendJson(response,speaker?200:404,speaker?{speaker}:{error:"Speaker profile not found"});return;
        }
        if(speakerMatch&&request.method==="DELETE"){
          await ready();const deleted=await speakerIdentity.delete(decodeURIComponent(speakerMatch[1]));sendJson(response,deleted?200:404,deleted?{success:true}:{error:"Speaker profile not found"});return;
        }
        const speakerRevokeMatch=pathname.match(/^\/api\/speakers\/([^/]+)\/revoke$/);
        if(speakerRevokeMatch&&request.method==="POST"){
          await ready();const speaker=await speakerIdentity.revoke(decodeURIComponent(speakerRevokeMatch[1]));sendJson(response,speaker?200:404,speaker?{speaker}:{error:"Speaker profile not found"});return;
        }

        if (request.method === "GET" && pathname === "/api/owner/profile") {
          await ready(); sendJson(response, 200, { owner: await storage.getOwner(ownerId) }); return;
        }

        if (request.method === "GET" && pathname === "/api/voice-benchmark/readiness") {
          await ready(); sendJson(response, 200, await voiceBenchmark.readiness()); return;
        }
        if (request.method === "POST" && pathname === "/api/voice-benchmark/sessions") {
          await ready(); sendJson(response, 201, { session: await voiceBenchmark.createSession() }); return;
        }
        const benchmarkSessionMatch = pathname.match(/^\/api\/voice-benchmark\/sessions\/([^/]+)$/);
        if (benchmarkSessionMatch && request.method === "GET") {
          await ready(); const session = await voiceBenchmark.getSession(decodeURIComponent(benchmarkSessionMatch[1])); sendJson(response, session ? 200 : 404, session ? { session } : { error: "Benchmark session not found" }); return;
        }
        if (request.method === "POST" && pathname === "/api/voice-benchmark/stt") {
          await ready(); const result = await voiceBenchmark.runStt(await readJsonBody(request, config.voiceBenchmark.maxBodyBytes)); sendJson(response, 200, { result }); return;
        }
        if (request.method === "POST" && pathname === "/api/voice-benchmark/tts") {
          await ready(); const result = await voiceBenchmark.runTts(await readJsonBody(request, config.maxBodyBytes)); sendJson(response, 200, { result }); return;
        }
        const benchmarkRatingMatch = pathname.match(/^\/api\/voice-benchmark\/results\/([^/]+)\/ratings$/);
        if (benchmarkRatingMatch && request.method === "PATCH") {
          await ready(); const result = await voiceBenchmark.rate(decodeURIComponent(benchmarkRatingMatch[1]), await readJsonBody(request, config.maxBodyBytes)); sendJson(response, 200, { result }); return;
        }

        if (request.method === "PATCH" && pathname === "/api/owner/profile") {
          await ready(); const patch = validateOwnerProfilePatch(await readJsonBody(request, config.maxBodyBytes));
          sendJson(response, 200, { owner: await storage.updateOwner(ownerId, patch) }); return;
        }

        if (request.method === "GET" && pathname === "/api/memories") {
          await ready(); const limit = validateListLimit(url.searchParams.get("limit"), 100, 200);
          const memories = await storage.listMemories(ownerId, { category: url.searchParams.get("category") || undefined, scope: url.searchParams.get("scope") || undefined, projectId: url.searchParams.get("projectId") || undefined, limit });
          sendJson(response, 200, { memories }); return;
        }

        if (request.method === "POST" && pathname === "/api/memories") {
          await ready(); const input = validateMemoryCreate(await readJsonBody(request, config.maxBodyBytes));
          sendJson(response, 201, { memory: await storage.createMemory({ ...input, ownerId }) }); return;
        }

        const memoryMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
        if (memoryMatch && request.method === "PATCH") {
          await ready(); const patch = validateMemoryPatch(await readJsonBody(request, config.maxBodyBytes));
          const memory = await storage.updateMemory(decodeURIComponent(memoryMatch[1]), ownerId, patch);
          sendJson(response, memory ? 200 : 404, memory ? { memory } : { error: "Memory not found" }); return;
        }
        if (memoryMatch && request.method === "DELETE") {
          await ready(); const deleted = await storage.deleteMemory(decodeURIComponent(memoryMatch[1]), ownerId);
          sendJson(response, deleted ? 200 : 404, deleted ? { success: true } : { error: "Memory not found" }); return;
        }

        if (request.method === "GET" && pathname === "/api/conversations") {
          await ready(); const limit = validateListLimit(url.searchParams.get("limit"), 20, 100);
          sendJson(response, 200, { conversations: await storage.listConversations(ownerId, { limit }) }); return;
        }

        if (request.method === "GET" && pathname === "/api/tools") { await ready(); sendJson(response,200,{tools:toolRegistry.list()}); return; }
        if (request.method === "GET" && pathname === "/api/projects") {
          await ready(); const projects=await storage.listProjects(ownerId);
          sendJson(response,200,{projects:await Promise.all(projects.map(async(project)=>({...project,memories:await storage.listMemories(ownerId,{projectId:project.id,limit:20}),runs:await storage.listRuns(ownerId,{projectId:project.id,limit:10}),activity:await storage.listActivity(ownerId,{projectId:project.id,limit:10})})))}); return;
        }
        if (request.method === "GET" && pathname === "/api/runs") { await ready(); sendJson(response,200,{runs:await storage.listRuns(ownerId,{projectId:url.searchParams.get("projectId")||undefined,limit:validateListLimit(url.searchParams.get("limit"),50,100)})}); return; }
        if (request.method === "GET" && pathname === "/api/activity") { await ready(); sendJson(response,200,{activity:await storage.listActivity(ownerId,{projectId:url.searchParams.get("projectId")||undefined,runId:url.searchParams.get("runId")||undefined,limit:validateListLimit(url.searchParams.get("limit"),100,200)})}); return; }
        if (request.method === "GET" && pathname === "/api/approvals") { await ready(); sendJson(response,200,{approvals:await storage.listApprovals(ownerId,{status:url.searchParams.get("status")||undefined,limit:validateListLimit(url.searchParams.get("limit"),50,100)})}); return; }
        const approvalMatch=pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
        if(approvalMatch&&request.method==="POST"){
          await ready(); const decision=validateApprovalDecision(await readJsonBody(request,config.maxBodyBytes)); const approval=await storage.decideApproval(decodeURIComponent(approvalMatch[1]),ownerId,decision);
          if(!approval){sendJson(response,404,{error:"Pending approval not found"});return;}
          await storage.appendActivity({ownerId,projectId:approval.projectId,runId:approval.runId,action:`approval_${decision}`,tool:approval.tool,status:decision,summary:`Owner ${decision} ${approval.tool}.`});
          let execution;
          if(decision==="approved"){
            try{execution=await toolRegistry.execute(approval.tool,approval.arguments,{approvalId:approval.id,runId:approval.runId,projectId:approval.projectId});await storage.appendActivity({ownerId,projectId:approval.projectId,runId:approval.runId,action:"approved_action_completed",tool:approval.tool,status:"completed",summary:`Approved ${approval.tool} action completed.`});if(approval.runId)await storage.updateRun(approval.runId,ownerId,{status:"completed",result:execution,completedAt:new Date().toISOString()});}
            catch(error){await storage.appendActivity({ownerId,projectId:approval.projectId,runId:approval.runId,action:"approved_action_failed",tool:approval.tool,status:"failed",summary:`Approved ${approval.tool} action failed safely.`});if(approval.runId)await storage.updateRun(approval.runId,ownerId,{status:"failed",error:"Approved action failed.",completedAt:new Date().toISOString()});throw error;}
          }else if(approval.runId)await storage.updateRun(approval.runId,ownerId,{status:"cancelled",error:"Owner rejected the requested action.",completedAt:new Date().toISOString()});
          sendJson(response,200,{approval,...(execution!==undefined?{execution}:{})});return;
        }

        const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if (conversationMatch && request.method === "GET") {
          await ready(); const limit = validateListLimit(url.searchParams.get("limit"), 100, 100); const offset = validateListOffset(url.searchParams.get("offset"));
          const messages = await storage.listMessages(decodeURIComponent(conversationMatch[1]), ownerId, { limit, offset });
          sendJson(response, 200, { messages, ...(messages.length === limit ? { nextOffset: offset + limit } : {}) }); return;
        }

        if (request.method === "POST" && pathname === "/api/missed-call") {
          const lead = validateMissedCallRequest(
            await readJsonBody(request, config.maxBodyBytes)
          );
          sendJson(response, 202, {
            success: true,
            message: "Missed call received",
            lead
          });
          return;
        }

        sendJson(response, 404, { error: "Not found" });
      } catch (error) {
        if (error instanceof ValidationError) {
          sendJson(response, 400, { error: error.message });
          return;
        }

        if (error instanceof StorageUnavailableError) {
          sendJson(response, 503, { error: "Nova's private storage is temporarily unavailable." }); return;
        }

        if (error instanceof BenchmarkValidationError) { sendJson(response, 400, { error: error.message }); return; }
        if (error instanceof BenchmarkLockedError) { sendJson(response, 403, { error: error.message, code: "BENCHMARK_PAID_CALLS_LOCKED" }); return; }
        if (error instanceof BenchmarkUnavailableError) { sendJson(response, 503, { error: error.message, code: "BENCHMARK_PROVIDER_UNAVAILABLE" }); return; }
        if (error instanceof BenchmarkBudgetError) { sendJson(response, 402, { error: error.message, code: "BENCHMARK_BUDGET_CAP" }); return; }
        if (error instanceof VoiceValidationError) { sendJson(response, 400, { error: error.message, code: "VOICE_VALIDATION" }); return; }
        if (error instanceof VoiceUnavailableError) { sendJson(response, 503, { error: error.message, code: "VOICE_UNAVAILABLE" }); return; }
        if (error instanceof VoiceTimeoutError) {
          logger.error("Nova voice provider timed out", { requestId, service: error.service, category: "provider_timeout_first_byte" });
          sendJson(response, 504, { error: "Voice provider timed out. Please try again.", code: error.code, category: "provider_timeout_first_byte" }); return;
        }
        if (error instanceof VoiceProviderError) {
          if (error.category === "client_cancelled") {
            logger.info("Nova voice stream cancelled", { requestId, service: error.service, category: error.category, detail: error.safeDetail });
            if (!response.writableEnded && !response.destroyed) sendJson(response, 499, { error: "Voice request cancelled.", code: error.code, category: error.category });
            return;
          }
          logger.error("Nova voice provider failed", { requestId, service: error.service, upstreamStatus: error.upstreamStatus, category: error.category, providerCode: error.providerCode, detail: error.safeDetail });
          const status = ["provider_timeout_first_byte", "provider_stream_stalled"].includes(error.category) ? 504 : 502;
          sendJson(response, status, { error: "Voice provider request failed. Your written conversation is safe.", code: error.code, category: error.category || "unknown" }); return;
        }

        if (
          error instanceof AgentStepLimitError ||
          error instanceof AgentToolCallLimitError
        ) {
          sendJson(response, 502, { error: error.message });
          return;
        }

        logger.error("Nova Brain request failed", {
          name: error?.name || "Error",
          code: error?.code || "INTERNAL_ERROR",
          service: error?.service,
          upstreamStatus: error?.upstreamStatus,
          requestId,
          runId: error?.runId,
          detail: error?.safeDetail
        });
        sendJson(response, 500, { error: "Internal server error" });
      }
    }
  });
}
