# Sharp Cuts Welcome back review — 20 November 2026

Preparation only, original connected Preview. No migration, sends, customer uploads, source edits, new subscriptions or queue release.

## Evidence
- Preserved source: report_client-list_2026-10-19.csv, SHA-256 71b8132097129df855a741ea8dc4b2a78011ffcec3d5162bf972530718fc6f42; 1,988 rows.
- 1,571 email rows, 1,558 distinct syntax-valid addresses, 13 repeated-address rows, 417 missing. This is not verified deliverability/consent.
- Existing staged cohort remains 1,562 profiles; profile identity and destination deduplication differ. Live membership is checked through the existing SELECT-only reader.
- Phone parsing: libphonenumber-js 1.12.31 max metadata, temporary local audit directory outside the application. 1,649 non-empty rows; 1 invalid; 1,648 valid rows; 1,314 distinct valid numbers; 334 duplicated valid rows; exclude 1 personal-number and 1 pager. 1,312 mobile candidates, no WhatsApp probes. Original digits are international numbers; normalise to E.164. No identifiers emitted.
- Mobile countries: GB 1,304; Latvia 2; Germany, Italy, Saint Lucia, UAE, New Zealand, Ghana 1 each.
- Authenticated Fresha UI: 1,999 current clients; 49 with future appointments; existing segment 44230 reports 1,724 past-client/no-appointment-in-90-days/no-future-booking profiles. These are aggregate totals, not matched recipients. No segment edited/saved. CSV export attempt did not produce a usable new local file; original source preserved. Marketing consent/optouts are absent from original export and staging view; do not infer permission from a booking or Fresha verification badge.
- Authenticated Sender Billing: Free Forever, 1/2,500 active subscribers, 1/2,500 unique emailed, 1/15,000 sends; renews 2 December. No payment method. Provider groups/campaigns are read again on each review.
- WhatsApp evidence retained from provider review: US$9.993 wallet, minimum topup US$10, observed 250-customer/24h limit, no approved marketing templates. Recheck before future launch.

## Costs
One email per eligible unique address fits current Free Forever quota: US$0 extra, required Sender branding.
One marketing template per all 1,312 mobile candidates: US$84.7287 including US$0.001 Gupshup fee/message; this is a planning ceiling, not an eligible audience. Additional wallet credit US$74.7357, plan US$75 before unverified taxes/FX/checkout fees. Existing credit is consumed rather than added again to total. Illustrative 20% tax scenario US$101.67, not a tax determination. Saint Lucia maps to Meta Other, not North America or Rest of Latin America. At observed limit allow 6 daily batches.
Sources: https://www.gupshup.ai/resources/wp-content/uploads/2026/11/USD_Oct2026.pdf ; https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing ; https://www.gupshup.ai/isv-partners/whatsapp-api/pricing ; https://www.sender.net/pricing/free-plan/

## Implementation
Marketing route renders complete text-led email creative and WhatsApp template proposal, exact team booking link, optout requirements, editable copy/channel/proposed time and durable review receipts in existing project Activity. Saving is preparation only; no provider writes, approval or schedule. API requires verified existing owner workspace and same-origin POST. Unknown launch eligibility is null, never a false claim of zero optouts or delivery. Launch remains held pending recipient-level evidence and separate exact approval.

## Execution recommendation
Existing inactive synthetic automations/n8n/sharp-cuts-retention-monitor.demo.json is not a connected n8n deployment. No live n8n binding found in inspected code/configuration. Reuse Nova approvals, durable worker, provider adapters and polling. n8n would add hosting/credentials/trigger authentication/callbacks/idempotency and maintenance without solving missing consent. Future appointment follow-ups need a supported fresh Fresha data path before adding orchestration. No extra execution agent needed for deterministic campaign delivery; Nova retains planning and oversight.

## Validation
26 focused tests pass: draft persistence, idempotency, escaped creative, pricing, private API, same-origin write boundary, source membership, suppression preservation, existing connected privacy and WhatsApp holds. Normal signed-in UI verification follows deployment; do not count these tests as campaign delivery.
Rollback: restore the stable Preview alias to deployment dpl_7vZTCKTP8okNBWNZQZxcGY5eVLHV (512e6a4). No DB rollback needed. Keep scnovawa.vercel.app on its existing receipt repair.

## Fresh reconciliation completed after initial deployment
The client-list export did arrive in Downloads. Its 20 November export has 1,999 records, Client ID, Accepts Marketing, Accepts SMS Marketing and Blocked columns; SHA-256 c0decc411df9d3fb0b536f535df9b594d488ae9cf4e84aa5b8fb3d5368b54ee8. The earlier absence-of-export conclusion above is superseded. Fresha's official consent guide explicitly describes these columns as marketing preferences.

The CSV exporter returns all clients even when the list is filtered; this was checked, not assumed to export a segment. The existing upcoming-appointment segment was therefore read through both UI pages (1–30 and 31–52), collecting 52 distinct Client IDs at 13:22 GMT. No segment criteria were changed. Counts had increased from 49 while this session was in progress, so refresh before launch.

Matched only to the 1,558 original distinct email addresses: 254 opted out, 22 blocked, 3 remaining ambiguous shared addresses, 39 upcoming bookings, 0 missing/unknown. These mutually exclusive exclusions leave 1,240 addresses with explicit Fresha email preference, no block, no sharing ambiguity and no upcoming booking at inspection. This is a broad Welcome back proposal, not a claim that all satisfy the separate 90-day segment. Preserve the 1,562 original profiles. Original and downloaded records stay unchanged. A private, gitignored local manifest holds the join for reproducibility; only counts and hashes are bundled into Nova. Audience hash f847215b4f330d5adb478e84e72274a92c0747ac22fc04dae60034546bdec6f7.

Sender UI lists two existing shop-owned records, neither in this shortlist. The review also reads a complete provider inventory for aggregate suppression status. Final recipient-specific suppression reconciliation, exact group transfer and provider draft validation remain required before separately approved launch. No upload or send occurred. SMS preference is not WhatsApp permission.

Normal signed-in Edge journey: saved review persisted across refresh, email and WhatsApp previews present. New tests cover conservative Fresha joining, exclusion priority, incomplete booking evidence, provider suppression counts without identifiers. Previous 26 passes are separate from the added targeted run.

Sender live inventory diagnosis: GET subscribers returned 2 records, current_page=1, total=2, last_page=1, but no links.next field. The older reader rejected the complete result. It now accepts complete meta pagination, checks stable totals and rejects contradictory next/page metadata. Regression fixture matches these observed fields. No suppression is removed or contact resubscribed.

## Approved provider preparation — 20 November
Owner explicitly approved transfer of the reconciled 1,240-address audience and an UNSENT draft. Email-only CSV had the same f847215b... audience hash; source exports were unchanged. Sender import receipt at 13:51:03 UTC: completed, 1,240 new, 0 updated, no errors/warnings. Trigger automations unchecked; update-existing and erase-empty-fields off. Both pre-existing account addresses were absent from the imported audience.

Created exactly one campaign J6P5lD, title Nova Sharp Cuts — Welcome back — e5a812712805, for existing group b8xDkj only. Confirm page shows 1,240 selected recipients, Sharp Cuts / info@sharpcuts.uk, exact reviewed subject and preheader. Custom HTML matches Nova's generated creative including team booking URL and Sender unsubscribe token. No test send, schedule or campaign send performed. Auto resend disabled on Free plan.

Nova now reads the bound campaign and complete provider group inventory. Aggregate audience fingerprint and exact content comparisons fail closed on mismatch. Provider submission count is distinguished from delivery; no provider delivery inferred. Customer rows remain outside Git and UI tool output.

Provider readback repair: full subscriber inventory now requests documented limit=100 (13 instead of 125 pages for 1,242 records). Reopened Sender HTML editor and compared exact persisted content: only the legacy unsubscribe token was converted to Liquid syntax. Comparison canonicalises that exact token only; changed destinations/content still fail. 27 focused checks passed. No sends or schedules.

The API additionally appends the mandatory Sender Free footer (exact 1,264-character branding table) and a closing-tag space. Compared as an explicit known suffix only; no arbitrary HTML/footer changes are ignored. Provider footer remains in the campaign. Read-only API rate limiting returned Retry-After 232 seconds on subscriber page 1; no contact mutations or retries occurred during that hold. 28 targeted checks passed.

Final provider UI export (20 Nov 14:15:21 UTC): 1,240 records, 1,240 unique addresses, all active and only the approved group. Node ordinal-sorted JSON address hash exactly matches f847215b4f330d5adb478e84e72274a92c0747ac22fc04dae60034546bdec6f7. CSV SHA256 8e96b5468b3aa847a063efc04a2be1bec4f291a81dbca7935ac850cff1fd3cf8. Live API still returned 429 on page 1 with Retry-After 815 at 14:12:54; no retries during that period. Timestamped export receipt is displayed separately, never represented as a live suppression pass or send authority. Provider API confirms creative matches, DRAFT, 1,240 recipients, zero submitted, no schedule/follow-up/errors. The existing restriction and source records remain untouched.
