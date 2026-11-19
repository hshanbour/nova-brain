# Connected Nova checkpoint — 19 November 2026

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
