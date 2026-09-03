export const SPEAKER_ENGINE_EVIDENCE = Symbol("nova.speakerEngineEvidence");

const STATUSES = new Set(["confirmed", "unknown", "uncertain", "insufficient", "non_speech", "failure"]);

export function createSpeakerEngineResult(input = {}) {
  const status = STATUSES.has(input.status) ? input.status : "failure";
  const result = {
    engineId: String(input.engineId || "unknown"),
    engineVersion: String(input.engineVersion || "unknown"),
    qualityState: String(input.qualityState || "unavailable"),
    status,
    candidateProfileId: typeof input.candidateProfileId === "string" ? input.candidateProfileId : null,
    category: typeof input.category === "string" ? input.category : null,
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
    threshold: Number.isFinite(input.threshold) ? input.threshold : null,
    ambiguityMargin: Number.isFinite(input.ambiguityMargin) ? input.ambiguityMargin : null,
    scoreMargin: Number.isFinite(input.scoreMargin) ? input.scoreMargin : null,
    representationId: typeof input.representationId === "string" ? input.representationId : null,
    latencyMs: Number.isFinite(input.latencyMs) ? input.latencyMs : null,
    candidateCount: Number.isFinite(input.candidateCount) ? input.candidateCount : 0,
    diagnostics: Object.freeze(safeDiagnostics(input.diagnostics)),
    error: input.error ? Object.freeze({ code: String(input.error.code || "engine_failure"), stage: String(input.error.stage || "recognition") }) : null
  };
  if (input.evidence !== undefined) Object.defineProperty(result, SPEAKER_ENGINE_EVIDENCE, { value: input.evidence, enumerable: false });
  return Object.freeze(result);
}

export function createSpeakerEngineCoordinator({ authoritativeEngine, shadowEngines = [], logger = console } = {}) {
  if (!authoritativeEngine?.authoritative) throw new Error("One authoritative speaker engine is required.");
  if (shadowEngines.some((engine) => engine?.authoritative)) throw new Error("Shadow speaker engines cannot be authoritative.");
  const shadows = Object.freeze(shadowEngines.filter(Boolean));
  return Object.freeze({
    authoritativeEngineId: authoritativeEngine.id,
    shadowEngineIds: shadows.map((engine) => engine.id),
    configured: Boolean(authoritativeEngine.configured),
    readiness: () => authoritativeEngine.readiness(),
    async recognize(input, context = {}) {
      const run = (engine) => Promise.resolve().then(() => engine.recognize(input, context)).catch((error) => createSpeakerEngineResult({ engineId: engine.id, engineVersion: engine.version, qualityState: "failure", status: "failure", error: { code: error?.code, stage: error?.stage } }));
      const [authoritative, ...shadow] = await Promise.all([run(authoritativeEngine), ...shadows.map(run)]);
      const comparison = shadow.map((result) => ({ engineId: result.engineId, status: result.status, confidence: result.confidence, agreement: compare(authoritative, result) }));
      logger.info?.("Nova speaker engine comparison", { requestId: context.requestId, authoritative: telemetry(authoritative), shadow: comparison });
      return { authoritative, shadow, comparison };
    }
  });
}

export function speakerFromAuthoritativeResult(result, fallbackVersion = "unknown") {
  if (result?.status === "confirmed") return { speaker_profile_id: result.candidateProfileId, speaker_label: result.category === "owner" ? "owner" : "enrolled_member", confidence: result.confidence, extractor_version: result.engineVersion || fallbackVersion, match_status: "confirmed", authenticated_identity: result.category === "owner" ? "owner" : "known_member", speaker_familiarity: "none", anonymous_speaker_id: null };
  const matchStatus = result?.status === "insufficient" ? "insufficient_speech" : result?.status === "non_speech" ? "non_speech" : result?.status === "uncertain" ? "uncertain" : "unknown";
  return { speaker_profile_id: null, speaker_label: "unknown", confidence: result?.confidence || 0, extractor_version: result?.engineVersion || fallbackVersion, match_status: matchStatus, authenticated_identity: "none", speaker_familiarity: "none", anonymous_speaker_id: null };
}

function compare(authoritative, shadow) {
  if ([authoritative.status, shadow.status].some((status) => ["failure", "insufficient", "non_speech"].includes(status))) return "insufficient_to_compare";
  return authoritative.status === shadow.status && authoritative.candidateProfileId === shadow.candidateProfileId ? "agree" : "disagree";
}

function telemetry(result) { return { engineId: result.engineId, status: result.status, confidence: result.confidence, candidateCategory: result.category, latencyMs: result.latencyMs, error: result.error }; }
const SAFE_DIAGNOSTICS=new Set(["totalAudioDurationSeconds","voicedDurationSeconds","silenceRatio","sampleRate","channelCount","preprocessingVersion","qualityGateReason","voicedSegmentCount","longestVoicedSegmentSeconds","clippingRatio","noiseFloorRms","activeThresholdRms","speechRms","peakRms","peakToNoiseDb"]);
function safeDiagnostics(value) { const safe = {}; for (const [key, item] of Object.entries(value || {})) if (SAFE_DIAGNOSTICS.has(key) && (item === null || ["string", "number", "boolean"].includes(typeof item))) safe[key] = item; return safe; }
