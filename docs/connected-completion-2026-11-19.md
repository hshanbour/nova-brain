# Connected Nova checkpoint — 19 November 2026

## Latest verified outcome (supersedes pending-payment notes below)

- Receipt correction `0c6901e` deployed READY (`dpl_C6cnXM4GqUSAhnRHADq2d7idGNif`) and stable Nova alias updated. Initial auto-review blocked webhook alias update; 44 extra host-isolation probes proved all non-/wa routes blocked before private initialization, then review allowed update. `scnovawa.vercel.app` now points to the same corrected Preview. Public network checks: GET /wa 200, /, /index.html, /assets/console.js, /api/projects, /api/memories all 404; unauthenticated POST /wa 401. No new message or fabricated receipt. Old deployment `dpl_vrNDkjb3wR3C6wGdaUKV8vSkPTBJ` is webhook rollback target.
- Final queue aggregation: five queued records, min/max attempts zero; one replied test record, exactly one attempt. Provider status still submitted; recipient confirmation remains distinct evidence.
- Normal signed-in Nova Chat created and verified the empty Sender group `b8xDkj` at 21:00:58 GMT, durable owner/project-scoped binding stored. Provider review returned group empty, source 1,562 matched, no campaigns, no verified sendable audience. No contacts changed or sent. Retrieved the two existing campaign reviews instead of duplicating them.
- Fixed review presentation discovered through that UI: historical booking placeholder now resolves in derived provider HTML; original copy/hash stays unchanged. Current group binding is returned separately so historical snapshot blocks are not mistaken for current configuration. Operator reconciliation now reads the same durable group binding and requires the connected Preview; it was not run to transfer contacts.
- Sender-focused regression: 21/21. Existing source export/staging has no consent/opt-out evidence. Need the actual cohort's marketing-permission/opt-out evidence and current suppression/future-booking reconciliation before an approved transfer/send. Four shared addresses (1,562 profiles / 1,558 distinct addresses) remain preserved, not silently removed.
- Signed-in GET /api/voice/readiness: realtime available (`gpt-realtime-2.1`, WebRTC, marin); batch STT configured and existing ElevenLabs voice access verified. Speaker readiness reported Warming/readiness_budget_exceeded. No live microphone test performed in this continuation. Personal-device account-access choice is explicit, per-conversation and not a voice match; genuine spoken memory lifecycle and interruption remain owner acceptance steps.

- Owner completed the first US$10 recharge; Gupshup displayed 10 credits added and US$9.994 balance. No subscription or second recharge.
- Commit `dfe90bed2bc615ed815145ff06d91093adb5e400` deployed to the original connected Preview. One exact-record, recipient/hash-bound, expiring owner grant submitted only the persisted reply “Received, thank you.” at 20:51:24 GMT. Provider receipt `49b184e1-8fef-4745-af2d-9af9508211b1`. Owner explicitly confirmed receiving it. No further send is needed or authorised by that test grant.
- This proves genuine inbound receipt, project-scoped Brain draft, one provider submission, phone receipt (owner-confirmed), and persisted conversation. It does not prove unrestricted automation or Windows dispatch. Five historical records remain queued with zero attempts; general dispatch remains held.
- Provider receipt remains `submitted`. Two requests reached the webhook host at 20:51:35–36, but their payloads were not retained; their exact event type is unverified. `scnovawa.vercel.app` still points to Preview commit `2539ee5`.
- Confirmed callback implementation defect: Gupshup V3 supplies Meta's wamid as `id` and its own submission UUID as `gs_id`; Nova stored the latter but looked up only the former. Corrected selection to prefer `gs_id`, retain legacy id fallback only when absent, normalise enqueued to queued, and log only non-sensitive status/matched/identifier-kind. No retrospective fabricated delivery event or manual delivered-status overwrite.
- Regression run: 85/85 including V3 mapping, authentication, app/phone/owner boundaries, out-of-order callbacks, exact one-off submission, held queue and webhook-only host routing. Automated evidence, not live callback proof. Deployment of this correction is recorded in subsequent checkpoint.

Branch: `codex/combined-nova-preview-d5b5-c5bd`. Starting/deployed commit at checkpoint: `2d09296`. No Production promotion.

## Verified external evidence

- Narrow migration 032 executed on the original connected database with database/branch/compute guards, two-table NOWAIT lock, 2-second lock timeout and 5-second statement timeout. Only the two WhatsApp status CHECK constraints widened. Both validated. No schema-version marker or queue mutation. Five historical full rows retained hash `8b855558a01ff11198843e1185a8ba13`; outbound count zero.
- Normal Nova UI synthetic handler → real Brain → unsent draft, run `ca209126-8e8e-44c7-93ab-7057674a78bc`, test `0c3dc8bd-e491-498f-b422-d9ce77a503f1`. One in-memory attempt; awaiting owner review; provider calls zero; historical queue unchanged. Not Windows dispatch or provider delivery evidence.
- One support follow-up sent in existing Gupshup ticket 283747 from the shop mailbox at 19:54 GMT. Sent UI confirmed; no claim of support acknowledgement.
- Owner completed existing Gupshup MFA. Dashboard confirms existing SharpCutsNova app `5f408033-30dd-49a8-93c5-b1dd5078b03c`, shop number, Live. App overview fails with provider “Something went wrong”, including one retry.
- Fresh owner-controlled WhatsApp test reached original Nova DB at 20:01:38.284 GMT, text “Nova controlled test-please acknowledge receipt”, recordRef `7c225e4905b6ad5b4669867c25931195c199dabad5f9194ba0c30b4f0467ce3d`. Six inbound records now, zero attempts; five historical records remain held. This establishes fresh inbound receipt, not outbound delivery.
- Wallet UI: -US$0.006, zero overdraft, no previous recharge, minimum recharge US$10, non-refundable. Owner funding decision requested; no funding or send performed.
- Fresha source CSV headers and staging information_schema show no consent, opt-out or suppression fields. Existing customer profiles must not be treated as marketing permission. Source cohort remains 1,562 profiles / 1,558 distinct addresses.

## Voice implementation in progress

Explicit, conversation-only signed-in account permission for personally controlled device; strict per-speaker mode remains default. Thirty-minute purpose-bound HMAC grant, every private request still requires authenticated owner/workspace and current turn fence. Public guest never gets grant. Account access is never described as a biometric match. Owner must consciously select this option and switch to public guest before sharing microphone. Existing voiceprints, thresholds, avatar unchanged.

Focused account/turn/guest/regression tests: 25 passed before this checkpoint. Not live microphone acceptance. Pending deployment and normal UI preflight; spoken memory lifecycle and interruption still require owner live test.

## Remaining

- Reconcile fresh real-message draft, provider restrictions, and exact one-recipient test authority. No general sending or old-queue release.
- Dedicated Sender group/binding; provider/read-only recipient evidence and review copy. No bulk sending or customer upload.
- Deploy tested original branch, verify normal UI, then one coordinated Voice test. Keep prior Codex delegation/Gmail success; do not rerun completed jobs.

## Funding and connected deployment continuation

- Commit `3fd020f7301712b236ce10caa8de1f903ef22117` deployed READY to `nova-test-project-ghu7zc67n-hamodehshanbour-6196.vercel.app`; stable original branch alias explicitly moved to it. Normal signed-in UI and live Voice acceptance still pending. Focused regression run: 72/72; not live acceptance.
- Fresh real WhatsApp draft is persisted: run `72ddced4-6ea3-4a3c-b890-54aea1d1b60b`, reply “Received, thank you.”, recordRef above. No outbound submission; original queue unchanged.
- Owner approved one-time US$10 funding and single test reply. Owner also checked history and confirmed no prior recharge. Current wallet independently displays “No last recharge!”, balance -US$0.006, customer ID 4000388038. Other account recharge history was not independently reverified; connected Nova mailbox payment search had no results.
- Browser extension control remains unavailable (debugger unattached). Native Edge view recovered through existing window; no browser security settings changed.
- Entered exactly 10 in Add Balance, verified “Pay USD 10”. One click did not yield checkout or payment confirmation. Inspected empty billing fields via Change Details. Left owner on “Edit Billing details”; asked owner to enter actual payer details and complete the one-time $10 recharge, stopping on any higher total/subscription. No payment credentials entered, no confirmed charge. Screenshot `gupshup-first-recharge-billing.jpg` in workspace root.
- Pending controlled outbound must remain exact-record/one-recipient, one attempt with uncertain outcomes reconciled. Do not enable generic dispatch or release historical queue to test this.
- Sender UI dashboard and operator reconciliation still read static group binding; reconcile these consumers with durable binding before claiming campaign readiness. No contact transfer or campaign send authorised.
- Owner returned “done”: billing details saved, but wallet still negative and no completed recharge. Browser extension recovered. Opened provider checkout once after verifying no recharge; confirmed exact customer ID and ten credits. Stripe checkout is now open with US$10 selected (rather than its default GBP conversion), empty payment fields, save-information unchecked. Asked owner to complete secure payment and reply paid. No confirmed payment or outbound send yet. Do not recreate checkout/recharge while this attempt is pending; reconcile its return and wallet history first. Proof: workspace root `gupshup-ten-dollar-checkout.jpg`.
- Further inspection: the legacy automation dashboard passes senderConfig to senderReadiness but does not actually consume groupId/draftConfigured, so no dashboard patch is needed for that binding. Operator audience-reconciliation script still uses env group only and must be reconciled before running any transfer. No source change retained from this inspection.
## 2026-11-20 interruption repair

Original connected branch; rollback checkpoint ee16ae02318addb189bee44cdc0015b0bce68ee9 / dpl_2AaNrwo98UD7XJNnfcv6bh7KHAzN. No schema, service binding, worker, queue, avatar or production changes.

Evidence: 11:36-11:37 GMT session on ee16ae0 used signed_in_account_session, not a biometric match. Applied browser settings were 48 kHz mono, echo cancellation/noise suppression/automatic gain enabled. At 11:37:04.018 audible output was observed; at 04.521 a VAD start cancelled it, cleared at 04.530. Source audio was not retained: room noise versus echo versus intentional speech cannot be established. Strict identity rejection was not the cause of these turns.

Two overlapping Brain requests in conversation 0897e0e1-47b9-4968-a3f9-478f542318a9 completed (runs 1ab63119-8a92-4547-ad49-08913f5ce677 and 61e6a3de-d3a5-410d-aecf-63a502a2b024), but the second produced client brain-turn-failed. Reproduced cause: shared conversation binding revision changes after the first result, invalidating the second concurrent result. Its context was also read before the preceding answer was stored. The clear Arabic acknowledgement was consequently answered as unclear. No memory tool executed in this exchange; no successful save is claimed.

Repair: serialize isolated Brain requests (stale results remain inaudible); explicitly recognise contextual short yes/no replies in communication policy. Disable provider automatic cancellation for isolated sessions. For explicit personal-device account mode only, qualify an interruption by 300 ms sustained VAD or an intelligible short transcript; discard empty brief candidates. Strict per-speaker mode still immediately protects private output. This cannot guarantee rejection of sustained room speech or echo.

Explicit fallback: choose Tap to talk before starting. Tracks are disabled until provider acknowledges manual VAD configuration and buffer clear. Speak cancels playback and opens the same mic track; Send speech closes it, drains 250 ms and commits one input item through the same transcription, authorisation and Brain path. Mute also stops the identity recorder/PCM; stale callbacks cannot start work. Public guest manual turns have no private Brain or speaker access. No hidden mode changes.

Official protocol reference: https://developers.openai.com/api/docs/guides/realtime-conversations (WebRTC push-to-talk, manual commit and disabled automatic interruption).

Tests: 153 focused checks passed (Voice/fence/capture/memory receipt/history/WhatsApp/Sender/Gmail/delegation), 9 UI/results checks passed, plus final 8 noise/manual-control cases passed. Simulated evidence only. Real microphone acceptance remains outstanding. No new recorded owner sample retained.

Business checkpoint: database still has 5 historical inbound queued / 0 attempts; 1 replied / 1 attempt; 1 outbound submitted. Owner-confirmed phone receipt is preserved separately from provider delivered status. Webhook deployment log counts since Nov19 21:00 show no /wa callback; no fabricated status update or resend. Sender group b8xDkj and two existing drafts retained. 1,562 profiles / 1,558 unique addresses; consent/opt-out source is missing, exact location requested. No upload, recipient changes or campaign send. Existing Gmail/direct-execution/Codex completion evidence is reused; regression checks preserve those paths without replaying jobs. Additional specialised agents would not address this event-ordering defect and are not introduced.
