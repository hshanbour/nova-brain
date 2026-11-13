# Temporary owner diagnostic — original connected Preview

Prepared from 5852c8a, on codex/combined-nova-preview-d5b5-c5bd. This is a diagnostic route, not enrollment, calibration or an authentication bypass.

## Retention and access

- One 24-second recording uses the same selected device, microphone constraints, preferred MediaRecorder encoding and 100 ms chunks as Nova. Automatic stopping is diagnostic-only; it avoids remote turn detection fragmenting this controlled sample.
- After recording, AES-GCM ciphertext and a non-exportable temporary key remain only in the signed-in browser tab's memory. No recording is written to browser storage, application storage, Git, a public URL or analytics. There is no downloadable sample.
- The displayed deadline is 30 minutes after server preparation. Server grants reject expiry. Client expiry, cancellation, navigation and pagehide discard key/ciphertext; a suspended browser cleans up on resume and checks expiry before reading. This is application-level deletion, not a guarantee of forensic erasure of OS/browser memory. Closing/reloading loses the sample permanently.
- Every comparison requires the existing server-verified owner/workspace session, same-origin request, consent and a separate expiring diagnostic-purpose grant. An unlocked owner browser can operate this page; account authentication does not establish the recording speaker's identity.
- Existing Modal nova-speaker-embedding-preview performs extraction using the existing token. Audio passes through the existing Nova API and Modal service, whose decoder scratch file is removed in finally. No new provider, database or credential is introduced. Only safe scalar results are returned; no embeddings, audio or private-access assertions appear in responses or ordinary logs.
- Diagnostic grants use a domain-separated MAC with the existing assertion key; they are not speaker assertions and cannot authorize private Voice. No enrolled representation or key is changed.

## Comparison

The original must have >=15 captured seconds, >=8 detected speech seconds, <0.5 second unexplained duration discrepancy, and <=2% clipping. An expected non-match does not discard it. Quality failures remain retained for inspection, without starting automatic derived comparisons.

Five sequential comparisons use: original bytes, identical original again, browser-decoded/resampled 16 kHz mono PCM, first half, second half. Each compares both existing VAD preprocessing and the full-waveform compatibility path against readable active owner profiles only. SHA-256 verifies the two original requests are identical. Derived buffers are discarded after comparison. The thresholds are unchanged. No transcript, chat, memory or tool request runs.

This can expose unstable repeated extraction, codec/resampling differences and inconsistent segments. It cannot retrospectively recover earlier recordings or conclusively establish why a historical encrypted profile fails authentication. The historical unreadable profile is reported separately and never rewritten.

## Acceptance boundaries

Synthetic tests cover access denial, no private assertion even on a diagnostic match, unchanged enrollment, unreadable-profile exclusion, quality gates, identical bytes, encryption/non-exportability, expiration including suspended timer behavior, manual deletion and cancellation races. A simulated browser lifecycle covers one recording, five comparisons, microphone shutdown and navigation deletion.

Real owner audio and any justified recognition repair remain pending until capture. Voice memory and interruption acceptance remain outstanding. Never label synthetic input or this diagnostic's match as a successful live conversational session.

Rollback is redeployment of 5852c8a on the same Preview alias. No migration or persistent data recovery is needed.
