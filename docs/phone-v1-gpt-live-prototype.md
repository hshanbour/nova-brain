# Phone V1 GPT-Live prototype

This is an isolated, non-PSTN architecture prototype. It is not wired into the current Preview Phone V1 route or Production.

## Boundary

- Twilio-compatible audio remains PCMU (`audio/pcmu`) at 8 kHz end to end.
- GPT-Live owns conversational listening, speech, turn-taking, and voice output.
- Nova Brain remains authoritative for durable memory, projects, tools, approvals, workflow state, and external actions through client delegation.
- Spoken approval never authorizes a consequential action. Formal Nova approval remains mandatory.
- Raw audio is forwarded ephemerally and is not included in controller state, audit events, or persistence.
- Provider credentials remain server-side.

## Reuse and replacement assessment

Unchanged reusable components include Twilio account/number handling, outbound approval and immutable intent records, exactly-once dial claim, one-active-call enforcement, Twilio callbacks and signature validation, Fly lifecycle, signed session authorization, durable call lifecycle records, Activity, and the Nova Brain tool/approval architecture.

The Twilio media transport and Fly session controller need a small adapter for GPT-Live events. A migrated Phone path would bypass the current separate OpenAI streaming STT and ElevenLabs phone TTS stages. Browser Voice V2 remains separate and unchanged.

## Certification interpretation

The provider-backed harness is intentionally standalone and creates no Twilio resources. ElevenLabs is used only to synthesize bounded caller fixtures; GPT-Live supplies assistant audio. Test output contains transcripts, timing, safe categories, and counters—not audio or secrets.

Official client delegation requires GPT-Live to emit `session.delegation.created`; the application then returns a verified result with `session.commentary.append`. The first provider-backed trial did not reliably emit delegation for an explicit Nova Brain request, so authoritative backend delegation is not yet live-certified. This blocks migration despite promising natural turn-taking and direct PCMU compatibility.

## Acceptance gate

Do not replace the current Phone V1 chain until a later isolated trial proves reliable client delegation, owner-reviewed voice quality, controlled interruption behavior, and the complete approval path. No PSTN trial should be used to resolve those questions.
