# Nova Phone V1 Phase 0 certification

This is a mock-only technical spike. It creates no phone tool, database schema, provider credential, number, account, deployment, or live call path.

## Certified boundary

The intended control and media split is:

1. Nova on Vercel owns call intent, policy, approval, durable state, memory, tools, conversation history, and Activity.
2. A small persistent Fly.io service owns only the active Twilio WebSocket, audio conversion, streaming transcription connection, TTS stream, interruption queue, and ephemeral per-call transport state.
3. Twilio sends mono `audio/x-mulaw` at 8 kHz. The bridge decodes and resamples it to PCM16 at 24 kHz for an OpenAI transcription session.
4. The bridge sends completed transcripts to the existing Nova agent turn pipeline.
5. Nova's owner-facing response is sanitised and requested from the existing ElevenLabs voice as `ulaw_8000`, then forwarded to Twilio without an extra lossy codec conversion.
6. Raw audio is not persisted.

## OpenAI streaming contract

The mock protocol follows the current official transcription-session shape: `gpt-live-transcribe`, PCM16 at 24 kHz, `turn_detection: null`, bridge-owned VAD/endpointing, `input_audio_buffer.append`, explicit `input_audio_buffer.commit`, and `item_id` correlation for final transcripts. Phase 0 performs no paid OpenAI request.

## Fly.io lifecycle

`phone-bridge/fly.toml.example` deliberately sets `min_machines_running = 0`, `auto_stop_machines = "stop"`, and `auto_start_machines = true`. A stopped Machine therefore has only stopped-rootfs cost, while connected calls hold an active proxy connection.

Outbound dial ordering must be:

1. Submit the already-approved immutable call intent.
2. Repeatedly request `https://<bridge>/health/ready` until it returns `{ "ready": true, "acceptingCalls": true }`.
3. Only after readiness succeeds may the future provider adapter call Twilio's dial API.
4. If readiness times out, fail without dialing.

Fly notes that a newly started Machine can briefly remain unavailable to some proxy nodes. The explicit readiness loop is therefore a safety boundary, not merely an optimization.

## Long calls

The bridge contains no three-minute timer and does not run in a Vercel Function. The synthetic soak feeds 180,000 twenty-millisecond frames, representing 60 connected minutes, through μ-law decoding and 24 kHz PCM conversion without retaining audio frames in bridge memory. A mock-tested wrapper rotates the OpenAI transcription connection between completed turns at 55 minutes without ending the Twilio/PSTN call. Provider-backed rotation remains a Phase 1 acceptance test.

## Known Phase 0 limits

- Mock construction proves ElevenLabs requests preserve Nova's configured voice ID/model and request `ulaw_8000`; only a provider-backed dry run can prove the account grants that exact combination.
- Unicode-preserving fixtures prove English, Arabic, and mixed text crosses every software boundary unchanged. They do not prove real telephone recognition accuracy.
- Provider latency, cold-start time, echo, noise, carrier behavior, and subjective voice quality require provider setup and live acceptance.
- The example Fly configuration is intentionally undeployed and has no app name, image, secrets, or production command.
