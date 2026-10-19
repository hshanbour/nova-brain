# Sharp Cuts customer migration contract (prepared, not applied)

## Existing target

The intended target is the existing Neon project `sharp-cuts-team-preview`, database `neondb`, after the owner confirms its relationship to `sharp-cuts-web`. Read-only inspection on 2026-10-18 verified that it already contains the booking-domain tables `sc_appointments`, `sc_blocks`, `sc_shifts`, `sc_barbers`, `sc_services`, `sc_offers` and related operational tables. No second Neon project is required.

No schema or data was changed during this preparation. The current `sc_appointments` table contains plaintext customer contact columns, so bulk Fresha migration must not write into it unchanged. The future Sharp Cuts Web repository must own and review the eventual migration.

## Proposed target records

The future migration should add an encrypted customer profile store and retain only deterministic keyed fingerprints outside ciphertext:

- `sc_customer_imports`: immutable source hash, export time, mapping version, record count, safe aggregate audit, actor, and confirmation that the raw export was deleted or placed under an approved retention policy.
- `sc_customers`: provider-independent customer UUID, encrypted profile envelope, keyed email/mobile fingerprints, latest consent/suppression provenance, first/last visit, next booking, status, source audit hash, and timestamps.
- `sc_customer_source_links`: encrypted provider source identifier plus keyed fingerprint, source system, import ID, first/last seen, and merge status.
- `sc_customer_merge_candidates`: two customer UUIDs, deterministic reasons, confidence class, status, and owner decision. No automatic destructive merge.
- `sc_campaign_proposals`: immutable audience snapshot hash, copy hash, channel, eligibility snapshot, expected cost, formal Nova approval ID, and terminal provider outcome. Approval never implies automatic retry.

Plaintext names, phone numbers, email addresses, Fresha identifiers, message bodies and private notes must not appear in audit logs, Nova Activity, fingerprints, URLs, or client-side payloads. Encryption and HMAC keys must be distinct, server-side only, Preview/Production separated, and rotation-aware.

## Import gates

1. Confirm the Neon project-to-`sharp-cuts-web` binding from deployment configuration; name and schema similarity are not proof.
2. Inspect only the Fresha export headers, then freeze a versioned column mapping.
3. Require exactly the expected profile count (currently 1,991) or stop as incomplete.
4. Produce a privacy-safe aggregate audit and pseudonymous duplicate candidates before staging any customer row.
5. Require owner approval for record-level import, retention period, duplicate decisions, and the exact target branch.
6. Test the migration on an isolated Neon branch using a direct connection; do not apply it to the live branch from Nova.
7. Reconcile counts and hashes, then delete or quarantine the raw export according to the approved policy.

## Appointment and occupancy mapping

`sc_appointments` is the only source of customer services. `sc_blocks` is non-bookable time. `sc_shifts` defines scheduled working time. A Fresha entry labelled `Walk-in` is not automatically a service: a long or evidence-free Walk-in interval is `ambiguous_walk_in_block`, excluded from booked minutes and from offerable availability until an owner resolves it. This prevents Nova from inflating occupancy or advertising a slot that may represent barber unavailability.

## Current boundary

The audit engine and migration-row builder operate on synthetic canonical records only. They emit HMAC identifiers and safe aggregates, retain no raw contacts, and fail closed on incomplete profile counts. A live export, database migration, customer import, campaign send, Instagram connection, or deployment remains a separate owner-authorised action.

