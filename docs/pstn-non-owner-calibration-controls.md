# Preview PSTN non-owner calibration controls

This Preview-only workflow collects anonymous false-owner calibration evidence. It does not enroll a participant and cannot select a threshold, create final PSTN calibration, or enable Owner Mode.

## Authority and consent

Mohammad first prepares one immutable `speaker_control_v1` call for the next anonymous slot (`control-01`, then `control-02`, then `control-03`) and separately approves the exact Phone call in Nova Console. Approval authorizes one dial attempt; it is not participant consent.

After the participant answers, Nova reads this disclosure completely:

> This optional call measures how a non-owner voice compares with Mohammad's Nova speaker recognition. Raw audio and temporary voice embeddings are processed ephemerally and discarded. No recognition profile is created. Only anonymous scalar scores, quality, consent and audit metadata remain. Press 1 to consent or 2 to refuse.

DTMF is ignored until playback of the disclosure is acknowledged. Pressing `1` records versioned participant consent and starts collection. Pressing `2` records refusal, collects no sample, and ends the call. Mohammad cannot provide this consent for another adult.

## Sample plan

Each participant supplies exactly four accepted samples: two on a normal handset and two on speakerphone. Prompts are selected from Arabic, English, and natural mixed Arabic-English according to what the participant can speak naturally; the final three-participant plan must cover all three categories. An accepted sample requires the existing worker quality gate and at least six seconds of useful voiced speech. Failed audio is discarded and does not count.

The processing boundary is the existing PSTN path: Twilio PCMU 8 kHz, server-side decode/resample and speech extraction, then `speechbrain/spkrec-ecapa-voxceleb@ecapa-v1`. Raw audio and the control embedding exist only for the request. Durable storage receives only the anonymous slot, consent/audit state, prompt condition and language, safe quality metadata, rounded cosine score, and model/preprocessing provenance.

## Bounds

- Three completed anonymous participant slots and twelve accepted samples maximum.
- One approved dial attempt and ten minutes maximum per prepared call.
- Recording disabled; no raw-audio or control-embedding column exists.
- No participant name or permanent speaker profile.
- Workflow cost cap: USD 5; stop for owner authorization before exceeding it.
- Aggregate diagnostics are review-only and include score ranges and the observed gap to Mohammad's held-out PSTN evidence. They never activate recognition policy.
