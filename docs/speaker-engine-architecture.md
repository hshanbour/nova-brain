# Nova speaker-engine architecture

ECAPA is the only authoritative engine. Voice audio is evaluated in parallel with STT, then only the authoritative normalized result can be signed and passed to the agent authorization policy. Shadow engines are telemetry-only and cannot issue assertions, grant owner status, or alter the user-visible result.

The common result includes engine identity/version, quality, speaker status, candidate/category, confidence, optional threshold and ambiguity data, representation identifier, latency, safe diagnostics, and a bounded failure state. Raw audio and biometric representations are excluded from telemetry.

Picovoice Eagle is intentionally disabled. Eagle supports Web and Node.js, processes mono 16-bit PCM at the SDK-reported sample rate, consumes streaming frames, and returns per-profile scores or null when voice is insufficient. Eagle Profiler must independently enroll each speaker and exports a binary Eagle profile; an ECAPA embedding cannot be converted into that profile. Eagle runs locally/on-device but requires a secret Picovoice AccessKey that verifies account limits. A free trial is available for enterprise development; current commercial terms and limits must be confirmed in Picovoice Console or with sales before activation.

Official references: https://picovoice.ai/docs/eagle/, https://picovoice.ai/docs/api/eagle-nodejs/, and https://picovoice.ai/docs/api/eagle-web/.

Future activation requires an explicit configuration and acceptance gate. Eagle must begin as shadow-only, with ECAPA remaining authoritative until representative owner, unknown-speaker, language, acoustic-condition, insufficient-speech, privacy, and latency evidence supports an explicitly approved promotion.
