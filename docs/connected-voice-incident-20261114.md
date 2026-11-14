# Connected Preview voice incident — 14 November 2026 (UTC)
Affected release: 63e8b6c. Evidence: original deployment runtime events, the signed-in Edge conversation and scoped PostgreSQL reads. No recording retained or reconstructed.

| Time | Observed |
| --- | --- |
| 14:31:53–14:32:13 | Edge supplied 48 kHz mono with echo cancellation, noise suppression and auto gain enabled. The first 11.72 s PCM turn decoded to 11.72 s, including 8.83 s detected speech. ECAPA scored 0.510 against 0.35; server authorised owner, then invoked Brain. |
| 14:32:14–17 | The persisted input contained the greeting, the colloquial request to save, and the Saturday-card colour. Brain took 4.0 s, returned a clarification with zero tools. No memory changed, no learning candidate was created and no matching memory was present. The access gate did not cause this write failure. |
| 14:32:17–43 | Another VAD start coincided with requested playback. The app blocked the now-stale first response and cleared its audio. Turns 2, 3 and 4 were superseded before a usable response. No stale first-response playback is evidenced. |
| 14:32:44–14:33:27 | Turns 5, 7 and 8 were unverified, transcribed and routed to public replies; buffer start followed detected speech end by approximately 2.08, 1.66 and 2.47 s respectively. Turn 6 scored 0.505 but had already been superseded. Turn 8 started during playback of turn 7, which was cleared. These are buffer events, not proof of what was audible in the room. |

Only turn 1 reached Brain. No public transcripts, audio, mute transition or output-language measurements were retained from this build. A second input during playback does not identify its source. The actual language, cause of the later VAD starts and time of any mute click cannot be reconstructed.

Repair: the explicit-memory gate now recognises a bounded colloquial save introduction after greetings and preserves the payload and existing safety and receipt checks. The connected session uses semantic end-of-turn detection and far-field noise suppression; every new speech start still protects private context. Mute now covers pending microphone permission, raw tracks, capture buffers, recorder, old speaker/Brain requests and output, with an explicit recovery after unmute. Only fresh turns are eligible. Unsupported-script input cannot be passed to Brain as a meaningful request; unexpected dominant scripts in streaming output trigger cancellation when the transcript becomes available. This is not an acoustic language detector. Future telemetry records script counts, correlated playback and local meters, not private transcripts or audio.

Release scope: original Preview only. For rollback repoint its existing private branch alias to the previous deployment and revert the change on that branch. No schema update, provider activation or backlog release is part of this deployment.
