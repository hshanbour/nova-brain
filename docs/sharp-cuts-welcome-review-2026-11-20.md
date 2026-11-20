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
