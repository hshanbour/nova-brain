# Fresha live lifecycle proof — 21 November 2026

The owner-authorised test ran through Nova's signed-in Sharp Cuts Bookings page, durable `fresha_controlled_20261121` task, and the dedicated authenticated local executor. No manual Codex Fresha writes were used.

- Fresha booking reference: **1830348930**; provider parent appointment: **1354972338**.
- Hamood, Haircut (no beard trim), 25 minutes, walk-in with no customer profile.
- Created once at **12:40–13:05 GMT**; fresh provider read verified the recorded ID and details.
- Rescheduled the same ID to **13:10–13:35 GMT**, selected from fresh provider availability. Fresh read verified the changed time at 12:53:10 GMT.
- Cancelled the same ID, confirmation explicitly said **No fee will be charged**. Fresh provider detail showed **Cancelled**, Walk in, correct service/staff/time. Final queue receipt observed **12:57:49 GMT**.
- No customer profile, notifications, checkout or payment. Existing appointments and held queues were not modified.

## Reconciled UI defects

The first post-create read occurred during placeholder loading. The subsequent read confirmed the recorded ID, without repeating Save. A raw innerText comparison after rescheduling differed from the normalised visible text; a specific visible service/time locator verified it. Fresha's cancelled detail changes the walk-in label to `Walk in`, handled separately. Each ambiguous result stopped writes and was reconciled through a fresh read. Provider IDs were never replaced.

## Scope

This proves the narrow real walk-in lifecycle on the local dedicated worker, not general customer booking readiness or unattended hosted execution. The adapter is date-bound and single-creation guarded. Hosted execution while the laptop is closed remains unverified and requires the separate hosting decision. No paid hosting was provisioned.

Private browser profile, journal and raw diagnostics remain outside the repository in the owner/SYSTEM-protected FreshaExecutor directory. No credentials or customer lists are included here. Saved Nova queue history preserves the intermediate failures and reconciliation evidence.
