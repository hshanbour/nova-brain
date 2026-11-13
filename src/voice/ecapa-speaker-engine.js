import { createSpeakerEngineResult, SPEAKER_ENGINE_EVIDENCE } from "./speaker-engine.js";

export function createEcapaSpeakerEngine({ extractor, identity } = {}) {
  if (!extractor || !identity) throw new Error("ECAPA engine requires extractor and identity services.");
  return Object.freeze({
    id: "ecapa",
    version: "speechbrain-ecapa",
    authoritative: true,
    configured: Boolean(extractor.configured),
    async readiness() {
      const [worker,enrollment]=await Promise.all([extractor.readiness(),identity.enrollmentReadiness?.({diagnostics:true})]);
      return {...worker,...(enrollment?{enrollment}:{})};
    },
    async recognize(input, { requestId, transcriptPromise, readyPromise, signal, speakerCalibration } = {}) {
      try {
        const [extracted, transcription] = await Promise.all([extractor.extract(input, { requestId, signal }), transcriptPromise, readyPromise]);
        const hasTranscript = Boolean(String(transcription?.transcript || "").trim());
        const diagnostics = extractionDiagnostics(extracted, input, hasTranscript);
        // No profile query is needed when there is no usable representation.
        // A slow database read must not mask the real speech-quality result.
        if (!extracted.sufficient || !hasTranscript) return createSpeakerEngineResult({ engineId: "ecapa", engineVersion: extracted.extractorVersion, qualityState: extracted.quality || "rejected", status: hasTranscript ? "insufficient" : "non_speech", latencyMs: extracted.latencyMs, candidateCount: 0, diagnostics, evidence: extracted });
        const match = typeof identity.recognizeMany === "function" ? await identity.recognizeMany(extracted.representationVariants || [{ label: "vad_v3", representation: extracted.representation }], speakerCalibration) : await identity.recognize(extracted.representation);
        Object.assign(diagnostics,match.comparisonDiagnostics||{}, {claimedAudioDurationSeconds:Number(input.durationSeconds)||0,encodedBytes:typeof input.audioBase64==='string'?Buffer.byteLength(input.audioBase64,'base64'):0,inputMimeType:input.mimeType||null});
        return createSpeakerEngineResult({ engineId: "ecapa", engineVersion: extracted.extractorVersion, qualityState: extracted.quality || "accepted", status: match.state, candidateProfileId: match.speakerProfileId, category: match.relation === "owner" ? "owner" : match.speakerProfileId ? "non_owner" : match.bestCandidateCategory, confidence: match.confidence, threshold: match.threshold, ambiguityMargin: match.ambiguityMargin, scoreMargin: match.scoreMargin, representationId: match.matchVariant, latencyMs: extracted.latencyMs, candidateCount: match.candidateCount, diagnostics, evidence: extracted });
      } catch (error) {
        return createSpeakerEngineResult({ engineId: "ecapa", engineVersion: "speechbrain-ecapa", qualityState: "failure", status: "failure", error: { code: signal?.aborted ? "recognition_deadline_exceeded" : error?.code || "ecapa_failure", stage: "speaker_embedding" } });
      }
    }
  });
}

export function evidenceFor(result) { return result?.[SPEAKER_ENGINE_EVIDENCE] || null; }

function extractionDiagnostics(value = {}, input = {}, hasTranscript = true) {
  return { totalAudioDurationSeconds: value.totalDurationSeconds ?? (Number(input.durationSeconds) || 0), voicedDurationSeconds: value.speechSeconds ?? null, silenceRatio: value.silenceRatio ?? null, sampleRate: value.sampleRate ?? null, channelCount: value.channelCount ?? null, preprocessingVersion: value.preprocessingVersion ?? null, qualityGateReason: hasTranscript ? value.reason || null : "empty_transcript", voicedSegmentCount: value.voicedSegmentCount ?? null, longestVoicedSegmentSeconds: value.longestVoicedSegmentSeconds ?? null, clippingRatio: value.clippingRatio ?? null, noiseFloorRms: value.noiseFloorRms ?? null, activeThresholdRms: value.activeThresholdRms ?? null, speechRms: value.speechRms ?? null, peakRms: value.peakRms ?? null, peakToNoiseDb: value.peakToNoiseDb ?? null };
}
