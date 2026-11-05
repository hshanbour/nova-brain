# Nova historical capability audit — 2026-11-05

This inventory is evidence-led. `verified` means supported by current code plus a focused test or a provider/runtime read-back. It does not mean a real external action was performed in this audit.

## Core architecture

| Capability | Current status | Evidence and boundary |
| --- | --- | --- |
| Project-scoped Nova Brain, memory, tools, approvals, audit | verified | Current agent, storage, approval, project-isolation, and execution tests. Consequential work remains formally approval-gated. |
| Sharp Cuts business workspace | verified in Preview | Project-scoped Meta identities/Insights, calendar, campaign, customer aggregate, Sender, media, and automation components are present. External sends/publishing remain independently gated. |
| Nova Digital Services and other projects | preserved | Project identifiers, credentials, storage queries, and automation controls remain scoped; this change introduces no cross-project migration. |
| Production | untouched | This release targets only `codex/combined-nova-preview-d5b5-c5bd`. |

## Voice, identity, dictation, and phone

| Capability | Status before this release | Restored/current status |
| --- | --- | --- |
| Browser conversational voice | regressed | The active browser path was a serial MediaRecorder → `gpt-transcribe` → Nova Brain → ElevenLabs Flash 2.5 chain. That path remains as recovery; the primary path is now WebRTC Realtime audio with server VAD and interruption. |
| Authoritative Nova reasoning | working | Realtime handles ordinary conversational turns directly for low latency. Business facts, project work, private context, tools, permissions, approvals, and consequential actions delegate through `nova_turn`; Nova Brain remains authoritative for them. |
| Bilingual English/Arabic | working in deterministic coverage; real microphone verification pending | Realtime and fallback both use automatic multilingual transcription. No language selector is required. |
| Barge-in/interruption | working in deterministic coverage; real microphone verification pending | Realtime uses provider interruption plus explicit cancel/clear. The older recovery path retains its checkpointed barge-in implementation. |
| Speaker identification | implemented, currently unavailable in the deployed runtime, and fail-closed | Historical ECAPA profiles remain server-side. The latest deployed readiness read-back reported `Warming` / `readiness_budget_exceeded`, so owner identity cannot currently be claimed from voice. Realtime submits an ephemeral per-turn sample when the matcher is available; a browser claim cannot assert owner identity. Sensitive actions remain approval-gated. |
| Owner enrolment | verified historical state, not recreated | Two encrypted active owner profiles were previously observed. Phone enrolment has two completed three-sample sessions (six accepted samples). This is separate from phone voice-selection samples. |
| Dictation | verified | Separate Stop & Review and Send Immediately controls, editable transcript, mixed Arabic/English server transcription, and stale-event fencing are covered by focused tests. |
| Phone control plane | verified but externally disabled | Immutable call envelopes, approval binding, one-call fencing, Twilio signatures, Fly bridge, and bounded GPT-Live prototype are present. No call was placed. |
| Phone voice-selection samples | planned, artifacts unverified | The retained generator defines three candidates (`marin`, `willow`, `gleam`) and four bilingual scripts: 12 planned outputs. No complete set of retained audio artifacts or final owner selection is present in repository evidence. |
| PSTN owner calibration | external blocker | The persisted calibration state was `consent_required` with zero PSTN samples. It cannot be claimed complete without a consented real call. |

## Sales agent

Historical code contains a safe phone envelope, conversational phone prompt, consultative/balanced/assertive sales modes, objection handling, and approved-offer boundaries. All styles must use only approved prices, services, evidence, offers, and next steps; refusals and do-not-contact requests end pressure immediately. This is verified by deterministic simulations only. Real outbound sales calls remain disabled and require separate owner approval and provider readiness.

## Business integrations

| Integration | Status | Remaining external boundary |
| --- | --- | --- |
| Instagram/Facebook identity and Insights | connected read-only | Publishing requires the already-designed organic publishing reauthorization and explicit content approval. |
| Sender email | connected and provider-approved in existing Preview work | Customer upload/bulk send still requires lawful audience reconciliation and campaign approval. |
| Sharp Cuts customer staging data | read-only aggregate path implemented | Consent/source/reachability gaps must remain unknown rather than inferred; no customer rows are exposed to the browser. |
| WhatsApp/Gupshup Coexistence | provider-side inbound blocker | Existing number/onboarding is preserved. Real inbound events had not reached Nova; support ticket `#283747` remains the provider blocker. |
| Fresha | live booking source | Nova does not claim live booking API access. Imported customer data is not treated as live availability or consent proof. |
| Windows media worker and private R2 | implemented with approval-before-upload | Only the exact approved final media may be promoted. Publishing remains disabled. |
| Calendar/approvals/automation pause controls | verified in Preview | Execution remains fail-closed when a project/channel is paused or approval is absent. |

## Validation limits

- Focused voice, phone, speaker, dictation, and sales coverage passes.
- The repository-wide test command contains long-running historical fixture suites that interfere when Node runs the entire tree concurrently; failures in those unrelated recovery fixtures predate and do not exercise this change. They are not hidden as a successful full-suite result.
- A genuine browser microphone, speaker output, provider timing, and 10-turn human conversation cannot be certified by deterministic mocks. The UI records speech-end-to-first-audio timing for the required owner-side ordinary-Edge verification.
- No external message, post, phone call, purchase, Production deployment, or customer mutation was performed.
