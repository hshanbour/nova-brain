import {createHmac, timingSafeEqual, randomUUID, createHash} from 'node:crypto';

export const DIAGNOSTIC_TTL_MS = 30 * 60 * 1000;
const variants = new Set(['original', 'original-repeat', 'decoded-full', 'first-half', 'second-half']);
const fail = (statusCode, code) => Object.assign(new Error(code), {statusCode, code});

// Accept only the exact PCM container produced by the diagnostic page. Slice
// decoded sample bytes (not WebM fragments); retain no file or new voiceprint.
export function diagnosticPcmWindow(wav, startSeconds, durationSeconds) {
  if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||wav.toString('ascii',12,16)!=='fmt '||wav.readUInt32LE(16)!==16||wav.readUInt16LE(20)!==1||wav.readUInt16LE(22)!==1||wav.readUInt32LE(24)!==16000||wav.readUInt16LE(34)!==16||wav.toString('ascii',36,40)!=='data'||wav.readUInt32LE(40)!==wav.length-44)throw fail(400,'diagnostic_pcm_invalid');
  const first=Math.round(startSeconds*16000)*2,count=Math.round(durationSeconds*16000)*2;
  if(first<0||count<=0||44+first+count>wav.length)throw fail(400,'diagnostic_window_invalid');
  const output=Buffer.alloc(44+count);wav.copy(output,0,0,44);output.writeUInt32LE(36+count,4);output.writeUInt32LE(count,40);wav.copy(output,44,44+first,44+first+count);return output;
}

// Diagnostic grants are deliberately NOT speaker assertions. No write, learning,
// private-turn authorization or enrollment service is reachable from this module.
export function createSpeakerDiagnostic({ownerId, key, extractor, identity, calibration, clock = Date.now}) {
  function signature(body) {
    if (typeof key !== 'string' || key.length < 32) throw fail(503, 'diagnostic_key_unavailable');
    return createHmac('sha256', key).update('nova-owner-diagnostic-v1\0' + body).digest();
  }
  function verify(token) {
    if (typeof token !== 'string' || token.length > 2048) throw fail(403, 'diagnostic_grant_required');
    const [body, encoded, extra] = token.split('.');
    const supplied = Buffer.from(encoded || '', 'base64url');
    const expected = signature(body || '');
    if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail(403, 'diagnostic_grant_invalid');
    let grant;
    try { grant = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw fail(403, 'diagnostic_grant_invalid'); }
    if (grant.ownerId !== ownerId || grant.purpose !== 'speaker-diagnostic-only' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= clock() || grant.expiresAt > clock() + DIAGNOSTIC_TTL_MS) throw fail(403, 'diagnostic_grant_expired');
    return grant;
  }
  return {
    async prepare() {
      const readiness = await extractor.readiness();
      if (!readiness.available) throw fail(503, 'speaker_service_unavailable');
      const grant = {id: randomUUID(), purpose: 'speaker-diagnostic-only', ownerId, expiresAt: clock() + DIAGNOSTIC_TTL_MS};
      const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
      return {diagnosticId: grant.id, token: body + '.' + signature(body).toString('base64url'), expiresAt: grant.expiresAt,
        retention: 'encrypted-browser-tab-memory-only', service: 'Existing nova-speaker-embedding-preview / SpeechBrain ECAPA',
        profiles: await identity.enrollmentReadiness({diagnostics: true})};
    },
    async compare(input, {requestId} = {}) {
      const grant = verify(input?.token);
      if (input.consent !== true || !variants.has(input.variant)) throw fail(400, 'diagnostic_consent_or_variant_invalid');
      const duration = Number(input.durationSeconds);
      if (!Number.isFinite(duration) || duration < 2 || duration > 30 || typeof input.audioBase64 !== 'string' || input.audioBase64.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64)) throw fail(400, 'diagnostic_audio_invalid');
      const bytes = Buffer.from(input.audioBase64, 'base64');
      if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw fail(400, 'diagnostic_audio_invalid');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      bytes.fill(0);
      let extracted;
      try { extracted = await extractor.extract({audioBase64: input.audioBase64, mimeType: input.mimeType, durationSeconds: duration}, {requestId}); }
      catch { throw fail(503, 'diagnostic_extraction_failed'); }
      verify(input.token); // Expiry also applies to a slow in-flight extraction.
      const quality = Object.fromEntries(['totalDurationSeconds','speechSeconds','silenceRatio','sampleRate','channelCount','preprocessingVersion','voicedSegmentCount','longestVoicedSegmentSeconds','clippingRatio','noiseFloorRms','activeThresholdRms','speechRms','peakRms','peakToNoiseDb','quality','reason','latencyMs','extractorVersion'].filter(k => ['number','string'].includes(typeof extracted[k])).map(k => [k,extracted[k]]));
      let match = null;
      try {
        if (extracted.sufficient) {
          const result = await identity.diagnoseOwnerRepresentations(extracted.representationVariants || [{label:'vad_v3',representation:extracted.representation}], calibration);
          match = {state: result.state, confidence: result.confidence, threshold: result.threshold, ambiguityMargin: result.ambiguityMargin, candidateCount: result.candidateCount, matchVariant: result.matchVariant, ...result.comparisonDiagnostics};
        }
      } finally {
        extracted.representation?.fill(0);
        for (const item of extracted.representationVariants || []) item.representation?.fill(0);
      }
      const full = input.variant === 'original' || input.variant === 'original-repeat';
      const useful = extracted.sufficient === true && (!full || (duration >= 15 && quality.speechSeconds >= 8 && Math.abs(quality.totalDurationSeconds-duration) < .5)) && (quality.clippingRatio ?? 1) <= .02;
      let windowComparisons;
      if(input.variant==='decoded-full'&&input.mimeType==='audio/wav'&&duration>=24){
        const pcm=Buffer.from(input.audioBase64,'base64');windowComparisons=[];
        try {
          for(const [start,seconds] of [[0,3.5],[4,3.5],[8,3.5],[12,3.5],[16,3.5],[20,3.5],[0,8],[12,8]]){
            verify(input.token);const window=diagnosticPcmWindow(pcm,start,seconds);
            try {
              const result=await this.compare({...input,variant:'first-half',audioBase64:window.toString('base64'),durationSeconds:seconds},{requestId});
              windowComparisons.push({startSeconds:start,durationSeconds:seconds,quality:result.quality,match:result.match,sha256:result.sha256,privateAccessGranted:false});
            }finally{window.fill(0);}
          }
        }finally{pcm.fill(0);}
      }
      return {diagnosticId: grant.id, variant: input.variant, sha256, encodedBytes: Buffer.byteLength(input.audioBase64, 'base64'), claimedDurationSeconds:duration, quality, match,
        ...(windowComparisons?{windowComparisons}:{}),usableDiagnostic: useful, diagnosticOnly: true, privateAccessGranted: false, profileUpdated: false, expiresAt: grant.expiresAt};
    }
  };
}
