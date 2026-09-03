import { randomUUID } from "node:crypto";
import { buildSpeakerSafeSystemContext, buildSystemContext, retrieveAgentContext } from "../memory/context-retriever.js";
import { ApprovalRequiredError } from "../policy/action-policy.js";

export class AgentStepLimitError extends Error {}
export class AgentToolCallLimitError extends Error {}

function validateModelOutput(output) {
  if (output?.type === "final" && typeof output.message === "string" && output.message) {
    return;
  }

  if (
    output?.type === "tool_calls" &&
    Array.isArray(output.toolCalls) &&
    output.toolCalls.every(
      (call) =>
        typeof call?.id === "string" &&
        call.id &&
        typeof call.name === "string" &&
        call.name &&
        call.arguments &&
        typeof call.arguments === "object" &&
        !Array.isArray(call.arguments)
    )
  ) {
    return;
  }

  throw new Error("Model provider returned an invalid output.");
}

function safeToolError(error, name) {
  if (error?.message === `Unknown tool: ${name}`) return error.message;
  return `Tool execution failed: ${name}`;
}

export function createAgent({
  storage,
  ownerId,
  modelProvider,
  toolRegistry,
  maxSteps = 5,
  maxToolCallsPerStep = 4,
  historyLimit = 24,
  memoryLimit = 6,
  verifySpeakerAssertion = () => null,
  validateSpeakerProfile = async () => false,
  validateAnonymousSpeaker = async () => false,
  logger = { info() {}, error() {} }
}) {
  if (!storage || !ownerId || !modelProvider || !toolRegistry) {
    throw new Error("Agent requires storage, ownerId, modelProvider, and toolRegistry.");
  }

  return Object.freeze({
    async run({ message, conversationId = randomUUID(), context = {}, requestId }) {
      const requestStartedAt=Date.now();
      const conversation = await storage.ensureConversation({ id: conversationId, ownerId, title: message.slice(0, 120) });
      if (!conversation) throw new Error("Conversation is unavailable.");
      const contextRetrievalStartedAt=Date.now();
      let verifiedSpeaker = context?.voice === true ? verifySpeakerAssertion(context?.speaker?.assertion) : null;
      if(verifiedSpeaker?.match_status==="confirmed"&&!(await validateSpeakerProfile(verifiedSpeaker.speaker_profile_id)))verifiedSpeaker=null;
      if(verifiedSpeaker?.anonymous_speaker_id&&!(await validateAnonymousSpeaker(verifiedSpeaker.anonymous_speaker_id)))verifiedSpeaker={...verifiedSpeaker,speaker_familiarity:"none",anonymous_speaker_id:null};
      const speakerRestricted = context?.voice === true && verifiedSpeaker?.speaker_label !== "owner";
      const trustedContext=context?.voice===true?{...context,speaker:verifiedSpeaker?.match_status==="confirmed"?{speaker_profile_id:verifiedSpeaker.speaker_profile_id,speaker_label:verifiedSpeaker.speaker_label,match_status:"confirmed",authenticated_identity:verifiedSpeaker.speaker_label==="owner"?"owner":"known_member",speaker_familiarity:"none",anonymous_speaker_id:null}:{speaker_profile_id:null,speaker_label:"unknown",match_status:verifiedSpeaker?.match_status||"unknown",authenticated_identity:"none",speaker_familiarity:verifiedSpeaker?.speaker_familiarity||"none",anonymous_speaker_id:verifiedSpeaker?.anonymous_speaker_id||null}}:context;
      if(context?.voice===true)logger.info("Nova speaker context verified",{requestId,assertionVerified:Boolean(verifiedSpeaker),matchStatus:trustedContext.speaker.match_status,speakerCategory:trustedContext.speaker.speaker_label,recognizedProfileId:trustedContext.speaker.speaker_profile_id,ownerPrivateContext:!speakerRestricted});
      const [run,conversationHistory,retrieved] = await Promise.all([
        storage.createRun({ ownerId, projectId: context.projectId || null, conversationId, goal: message, status: "planning" }),
        speakerRestricted ? Promise.resolve([]) : storage.listMessages(conversationId, ownerId, { limit: historyLimit }),
        speakerRestricted ? Promise.resolve(null) : retrieveAgentContext({ storage, ownerId, message, projectId: context.projectId, memoryLimit })
      ]);
      const contextRetrievalCompletedAt=Date.now();
      await Promise.all([
        storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "run_created", status: "completed", summary: "Execution run created." }),
        storage.appendMessage({ conversationId, ownerId, role: "user", content: message })
      ]);
      const systemContext = speakerRestricted ? buildSpeakerSafeSystemContext(verifiedSpeaker) : buildSystemContext(retrieved);
      const toolExecutions = [];
      let continuationToken;
      let toolResults = [];

      try { for (let step = 1; step <= maxSteps; step += 1) {
        await storage.updateRun(run.id, ownerId, { status: "running", currentStep: step });
        const agentGenerationStartedAt=Date.now();
        const protectedIdentityMessage = context?.voice===true ? identityBoundaryResponse(message,trustedContext.speaker) : null;
        const generated = protectedIdentityMessage ? { type: "final", message: protectedIdentityMessage } : await modelProvider.generate({
          message,
          context:trustedContext,
          systemContext,
          conversationHistory,
          tools: toolRegistry.list({ executableOnly: true }),
          toolResults,
          continuationToken
        });
        validateModelOutput(generated);
        const agentGenerationCompletedAt=Date.now();

        if (generated.type === "final") {
          const response = {
            id: randomUUID(),
            conversationId,
            message: generated.message,
            provider: modelProvider.name,
            toolCalls: toolExecutions,
            steps: step
            ,runId: run.id,
            runStatus: "completed",
            timing:{contextRetrievalMs:contextRetrievalCompletedAt-contextRetrievalStartedAt,preModelMs:agentGenerationStartedAt-requestStartedAt,agentFirstResponseMs:agentGenerationCompletedAt-agentGenerationStartedAt,agentCompleteMs:agentGenerationCompletedAt-agentGenerationStartedAt}
          };

          await storage.appendMessage({ conversationId, ownerId, role: "assistant", content: response.message });
          await storage.updateRun(run.id, ownerId, { status: "completed", currentStep: step, result: { message: response.message }, completedAt: new Date().toISOString() });
          await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "run_completed", status: "completed", summary: "Nova completed the execution run." });

          response.timing.totalMs=Date.now()-requestStartedAt;

          return response;
        }

        if (generated.toolCalls.length > maxToolCallsPerStep) {
          throw new AgentToolCallLimitError(
            `Model requested more than ${maxToolCallsPerStep} tools in one step.`
          );
        }

        if (step === maxSteps) {
          throw new AgentStepLimitError(
            `Agent exceeded the maximum of ${maxSteps} model steps.`
          );
        }

        continuationToken = generated.continuationToken;
        toolResults = [];

        for (const call of generated.toolCalls) {
          const execution = {
            id: call.id,
            name: call.name,
            arguments: call.arguments
          };
          await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "tool_started", tool: call.name, status: "running", summary: `Started ${call.name}.` });

          try {
            const result = await toolRegistry.execute(call.name, call.arguments, { ...trustedContext, runId: run.id });
            execution.status = "completed";
            execution.result = result;
            toolResults.push({ id: call.id, output: { ok: true, result } });
            await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "tool_completed", tool: call.name, status: "completed", summary: `${call.name} completed.` });
          } catch (error) {
            if (error instanceof ApprovalRequiredError) {
              const approvalMessage = `Owner approval is required before Nova can run ${call.name}.`;
              execution.status = "waiting_for_approval"; execution.approvalId = error.approval.id; toolExecutions.push(execution);
              await storage.updateRun(run.id, ownerId, { status: "waiting_for_approval", currentStep: step });
              await storage.appendMessage({ conversationId, ownerId, role: "assistant", content: approvalMessage });
              return { id: randomUUID(), conversationId, message: approvalMessage, provider: modelProvider.name, toolCalls: toolExecutions, steps: step, runId: run.id, runStatus: "waiting_for_approval", approval: error.approval };
            }
            execution.status = "failed";
            execution.error = safeToolError(error, call.name);
            toolResults.push({
              id: call.id,
              output: { ok: false, error: execution.error }
            });
            await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "tool_failed", tool: call.name, status: "failed", summary: execution.error });
          }

          toolExecutions.push(execution);
        }
      }

      throw new AgentStepLimitError(`Agent exceeded the maximum of ${maxSteps} model steps.`);
      } catch (error) {
        await storage.updateRun(run.id, ownerId, { status: "failed", error: error instanceof AgentStepLimitError || error instanceof AgentToolCallLimitError ? error.message : "Execution failed safely.", completedAt: new Date().toISOString() });
        await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "run_failed", status: "failed", summary: error instanceof AgentStepLimitError || error instanceof AgentToolCallLimitError ? error.message : "Execution failed safely." });
        error.runId ||= run.id;
        throw error;
      }
    },
    tools: toolRegistry
  });
}

function identityBoundaryResponse(message,speaker) {
  const value=String(message||"").trim();
  const asksRecognitionMethod=/how (?:did|do) you (?:recognize|know|identify) me|كيف (?:عرفتني|بتعرفني|تعرفت علي)|شلون (?:عرفتني|تعرفني)/iu.test(value);
  if(asksRecognitionMethod&&speaker?.authenticated_identity==="owner")return /[\u0600-\u06ff]/u.test(value)?"تحققت من هويتك لأن نظام التحقق الصوتي طابق صوت هالدور مع ملف صوت المالك المسجّل بموافقتك؛ معلومات الحساب والذاكرة ما استخدمتها كإثبات هوية.":"I verified you because the voice-verification system matched this turn to the consented enrolled owner profile; account information and memory were not used as authentication.";
  const asksPriorContact=/have we (?:spoken|talked|met) before|(?:حكينا|حكيت معي|تكلمنا) قبل/iu.test(value);
  if(asksPriorContact&&speaker?.speaker_familiarity==="known_anonymous")return /[\u0600-\u06ff]/u.test(value)?"هالصوت بيشبه بصمة صوت مجهولة تواصلت معي من قبل، بس هاد مش إثبات لهويتك وما بيعطيك صلاحيات خاصة.":"This voice appears to match an anonymous speaker I've interacted with before, but that does not verify your identity or grant private access.";
  const identitySensitive=/\b(?:who\s+am\s+i|i(?:'m|\s+am)\s+(?:mohammad|mohammed|the\s+owner)|i\s+own\s+(?:this|the)\s+(?:app|program|system))\b|(?:مين|من)\s+أنا|أنا\s+(?:محمد|محم[و]?د|صاحب\s+(?:البرنامج|النظام|التطبيق))/iu.test(value);
  if(!identitySensitive)return null;
  return /[\u0600-\u06ff]/u.test(value)?"ما قدرت أتحقق من هويتك من هالدور الصوتي. الادعاء بالاسم أو بصفة المالك ما بغيّر حالة التحقق.":"I couldn't verify your identity from this voice turn. Claiming a name or owner status does not change the verification result.";
}
