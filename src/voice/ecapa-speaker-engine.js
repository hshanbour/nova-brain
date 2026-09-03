import { createSpeakerEngineResult, SPEAKER_ENGINE_EVIDENCE } from "./speaker-engine.js";

export function createEcapaSpeakerEngine({ extractor, identity } = {}) {
  if (!extractor || !identity) throw new Error("ECAPA engine requires extractor and identity services.");
  return Object.freeze({
    id: "ecapa",
    version: "speechbrain-ecapa",
    authoritative: true,
    configured: Boolean(extractor.configured),
    readiness: () => extractor.readiness(),
    async recognize(input, { requestId, transcriptPromise, readyPromise } = {}) {
      try {
        const [extracted, transcription] = await Promise.all([extractor.extract(input, { requestId }), transcriptPromise, readyPromise]);
        const hasTranscript = Boolean(String(transcription?.transcript || "").trim());
        const diagnostics = extractionDiagnostics(extracted, input, hasTranscript);
        if (!extracted.sufficient || !hasTranscript) return createSpeakerEngineResult({ engineId: "ecapa", engineVersion: extracted.extractorVersion, qualityState: extracted.quality || "rejected", status: hasTranscript ? "insufficient" : "non_speech", latencyMs: extracted.latencyMs, candidateCount: await identity.candidateCount(), diagnostics, evidence: extracted });
        const match = typeof identity.recognizeMany === "function" ? await identity.recognizeMany(extracted.representationVariants || [{ label: "vad_v3", representation: extracted.representation }]) : await identity.recognize(extracted.representation);
        return createSpeakerEngineResult({ engineId: "ecapa", engineVersion: extracted.extractorVersion, qualityState: extracted.quality || "accepted", status: match.state, candidateProfileId: match.speakerProfileId, category: match.relation === "owner" ? "owner" : match.speakerProfileId ? "non_owner" : match.bestCandidateCategory, confidence: match.confidence, threshold: match.threshold, ambiguityMargin: match.ambiguityMargin, scoreMargin: match.scoreMargin, representationId: match.matchVariant, latencyMs: extracted.latencyMs, candidateCount: match.candidateCount, diagnostics, evidence: extracted });
      } catch (error) {
        return createSpeakerEngineResult({ engineId: "ecapa", engineVersion: "speechbrain-ecapa", qualityState: "failure", status: "failure", error: { code: error?.code || "ecapa_failure", stage: "speaker_embedding" } });
      }
    }
  });
}

export function evidenceFor(result) { return result?.[SPEAKER_ENGINE_EVIDENCE] || null; }

function extractionDiagnostics(value = {}, input = {}, hasTranscript = true) {
  return { totalAudioDurationSeconds: value.totalDurationSeconds ?? (Number(input.durationSeconds) || 0), voicedDurationSeconds: value.speechSeconds ?? null, silenceRatio: value.silenceRatio ?? null, sampleRate: value.sampleRate ?? null, channelCount: value.channelCount ?? null, preprocessingVersion: value.preprocessingVersion ?? null, qualityGateReason: hasTranscript ? value.reason || null : "empty_transcript", voicedSegmentCount: value.voicedSegmentCount ?? null, longestVoicedSegmentSeconds: value.longestVoicedSegmentSeconds ?? null, clippingRatio: value.clippingRatio ?? null, noiseFloorRms: value.noiseFloorRms ?? null, activeThresholdRms: value.activeThresholdRms ?? null, speechRms: value.speechRms ?? null, peakRms: value.peakRms ?? null, peakToNoiseDb: value.peakToNoiseDb ?? null };
}
