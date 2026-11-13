# Connected Preview: private turns, public clarification

Base: e13d843, original connected branch. No credentials, thresholds, enrolled profiles, database bindings, queues, outbound settings or avatar artwork changed.

## Evidence and decision

The deleted diagnostic recording scored 0.379622 against the unchanged 0.35 threshold. Both 12-second halves passed (0.368535 / 0.370332); three of five voiced short excerpts failed. This demonstrates unreliable short-clip matching in this existing profile/engine combination, not a reliable way to classify every non-match as another person. The unreadable second profile remains untouched; it has not been established as the cause of those failures.

Previously private identity/results entered the shared Realtime conversation. An inconclusive recheck therefore required destroying that provider session. This turned normal short utterances into pauses/restarts. A longer initial clip did not solve the ongoing problem.

The connected Preview now keeps one WebRTC conversation transport with isolated, explicit-input responses. The default provider conversation contains no private context, identity or tools. Input items are deleted after transcription. Each output uses `conversation: none`, an explicit input array and no tools. A response is correlated with its originating turn; late replies cannot attach to a newer speaker.

Each microphone recording is independently verified. No pooled owner audio, cached match, name assertion or lower threshold authorises a later speaker. Server-confirmed turns use existing Brain, memory and runtime paths. Only that isolated reply receives its result and server-sourced owner identity. An inconclusive turn can receive a public answer or a focused clarification without ending the connection. Public replies receive no earlier private transcripts or results. Public conversation is intentionally not durable private memory and currently has no cross-turn public history.

Missing transcript, uncertain identity and unavailable verification have separate explanations. Private actions remain gated. A completed owner action can remain in history after interruption, but its late result is not displayed or spoken to a subsequent guest. Interruption suppresses stale playback; it does not undo an already committed memory write.

## Verification

215 focused checks passed before the final late-UI guard; affected capture/UI checks rerun afterward. Coverage includes server assertions, account/caller boundaries, isolated public prompts, owner/uncertain/guest/owner transport continuity, late results, playback cancellation, live/demo status separation and existing memory receipt protections.

The seven-turn memory lifecycle test exercises the real Brain and memory tools with synthetic transcripts, scripted model output and in-memory storage across fresh conversation IDs. It checks Arabic/English retrieval, correction, deletion and execution receipts. It is not a real microphone, live model or persistent Neon acceptance test.

## Remaining acceptance

Real owner entry, short follow-ups, unclear speech, owner/guest/owner recovery, live memory lifecycle and audible interruption must be checked in the deployed Edge session. The engine's demonstrated short-clip limitation remains; this change makes uncertainty usable and private, not biometrically certain. If natural complete owner requests still cannot match reliably, the next smallest step is a separately scoped channel/profile calibration comparison using consented samples, not another retry button or a silent threshold reduction.

Rollback: restore the prior Preview alias or revert this code commit. No migration or data recovery is required.
