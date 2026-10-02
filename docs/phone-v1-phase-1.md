# Nova Phone V1 Phase 1

Phase 1 turns the Phase 0 media spike into a production-shaped, provider-disabled outbound-call architecture. It does not provision Twilio or Fly.io, buy a number, deploy a bridge, or place a call.

## Authority and execution boundary

Nova Brain remains authoritative. The Vercel application owns the immutable call envelope, formal approval, exactly-once dial claim, provider identity, bounded agent turns, durable lifecycle, transcript, summary, and Activity records. The Fly.io bridge is transport only: it holds the long-lived Twilio and OpenAI WebSockets, detects turns, requests Nova turns, streams ElevenLabs audio, handles interruption, and reports terminal state.

The flow is:

1. `phone_call_prepare` validates and persists an immutable call envelope.
2. `phone_call_start` reaches Nova's existing generic `SENSITIVE` approval boundary. Chat text is never approval.
3. The approval card shows the exact destination, expected party, disclosure, objective, approved context, permitted and prohibited actions, languages, time window, voicemail policy, maximum duration, single attempt, retention policy, and termination behavior.
4. Formal approval binds the approval ID to the envelope hash.
5. Execution wakes and health-checks the bridge before claiming the only dial attempt.
6. One atomic storage transition enforces the owner-wide one-active-call limit and binds the submission key plus a short-lived single-use bridge-start token before Twilio is contacted.
7. A definitive rejection ends the attempt. An ambiguous outcome becomes `uncertain`; Nova never retries it automatically.
8. Twilio's signed callback and the call-bound bridge token bind the Call SID and Stream SID before audio is accepted.

## Call envelope

Phase 1 is deliberately narrow:

- UK E.164 destinations only (`+44...`).
- Maximum duration must be 5, 10, 15, 30, or 60 minutes.
- Exactly one dial attempt.
- Authority expires within 24 hours.
- Calling windows use `Europe/London`.
- Recording is always disabled.
- Transcript retention is owner-private until deletion.
- Voicemail must be explicitly permitted or forbidden.
- Any consequential request outside the approved objective is refused and handed back to the owner.

The canonical JSON envelope is SHA-256 hashed. The approval, dial claim, bridge session, and every in-call request must match that hash.

## Durable state

Schema version 14 adds:

- `nova_phone_call_intents`: the immutable authority envelope, approval binding, one-attempt claim, provider identity, lifecycle, and outcome.
- `nova_phone_call_events`: idempotent provider/bridge lifecycle events.
- `nova_phone_call_turns`: bounded transcript and assistant-text turns with replay hashes.

There is intentionally no raw-audio column. Raw Twilio and generated ElevenLabs audio remain ephemeral in bridge memory. Phone transcripts are not promoted into general owner memory automatically.

Lifecycle states are `prepared`, `waiting_approval`, `approved`, `dialing`, `in_progress`, `completed`, `failed`, and `uncertain`. Terminal and in-progress states cannot be regressed by late provider callbacks.

## Bounded in-call Nova

Phone turns reuse the existing Nova agent/model pipeline with a dedicated call conversation, but a restricted profile:

- only the approved envelope context is supplied;
- ordinary conversation history, owner memory, project memory, Web, Gmail, workflows, and all tools are disabled;
- the caller is treated as untrusted;
- model tool calls or commitments outside the approved scope are replaced by a safe owner-confirmation response;
- duplicate turn IDs are idempotent, while changed replay content fails closed.

## Bridge transport

`phone-bridge/` is a small Node.js WebSocket service intended for Fly.io. It verifies the Twilio signature, accepts one call per Machine, enforces a bounded WebSocket payload, and never stores audio. Its health endpoints support pre-dial wake-up and readiness checks.

The media path remains:

`Twilio mu-law 8 kHz -> PCM16 24 kHz -> OpenAI gpt-live-transcribe -> Nova Brain -> ElevenLabs -> mu-law 8 kHz -> Twilio`

The bridge owns server-side VAD and explicit transcription commits. Speech while Nova is playing sends Twilio `clear`, invalidates stale audio, and starts the next caller turn. Maximum duration produces a final spoken handoff when possible, waits for the matching Twilio playback mark, then hangs up safely.

The example Fly configuration uses London, one shared 256 MB CPU, `min_machines_running = 0`, `auto_start_machines = true`, and autostop. A connected WebSocket keeps the Machine active; stopped Machines retain only their root filesystem charge.

## Configuration names

Nova/Vercel will eventually require:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `NOVA_PHONE_NUMBER`
- `NOVA_PHONE_BRIDGE_URL`
- `NOVA_PHONE_BRIDGE_WEBSOCKET_URL`
- `NOVA_PHONE_PUBLIC_BASE_URL`
- `NOVA_PHONE_SESSION_SIGNING_KEY` (base64 for exactly 32 random bytes)

The bridge will eventually require:

- `NOVA_PHONE_BRIDGE_PUBLIC_URL`
- `NOVA_PHONE_BASE_URL`
- `TWILIO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- optional `ELEVENLABS_TTS_MODEL`

No real values belong in source control. Phone tools remain unavailable unless Nova's complete configuration group is present.

## Provider-backed acceptance boundary

Mocks certify protocol construction, security checks, storage transitions, 60-minute operation, languages, interruption, and existing Nova regressions. They do not certify carrier delivery, real OpenAI transcript accuracy, the selected ElevenLabs voice's subjective telephone quality, echo/noise behavior, real cold-start time, Twilio webhook delivery, or provider account/format entitlements.

Before any real call, Phase 2 must provision a Preview-only bridge and provider credentials, validate signed callbacks and `ulaw_8000` with a provider-backed dry run, confirm current pricing and regulatory requirements, and run one explicitly approved owner-controlled call. Production must remain disabled until that acceptance succeeds.

## Cost model (October 2026 list-price assumptions)

For a UK mobile call, the current inputs used by the estimate are Twilio outbound voice at $0.0305/minute, Media Streams at $0.0044/minute, OpenAI `gpt-live-transcribe` at $0.017/minute, ElevenLabs Flash/Turbo TTS at $0.05 per 1,000 characters, and Fly shared-cpu-1x/256 MB at roughly $0.0028/hour while running. Nova model tokens, tax, carrier surcharges, and data transfer remain additional.

Assuming about 400 generated TTS characters per connected minute, the variable subtotal is approximately $0.072/minute before Nova model use and taxes. A UK local Twilio number is approximately $3.50/month. A stopped Fly Machine is charged for rootfs (about $0.15 per GB-month), while active compute scales by the second. ElevenLabs may impose a plan minimum depending on the owner's existing account even though API usage itself is metered.

These are planning estimates, not billing guarantees. Re-check destination, number, model, account-plan, and tax pricing immediately before Phase 2 provisioning.
