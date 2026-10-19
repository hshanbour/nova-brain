# Sharp Cuts Growth & Automation V1

## Selected first workflow

The first workflow is a read-only 30/45/60/90-day retention and capacity monitor. It consumes an owner-authorised Fresha-style export, excludes customers with a future booking, applies suppression and electronic-marketing-basis gates, and prepares a costed recommendation for owner review. A separate synthetic capacity fixture identifies waitlist, last-minute-offer and off-peak-pricing opportunities without changing prices, schedules or bookings. It never sends a message.

The checked-in n8n workflow is deliberately inactive and synthetic. It proves the orchestration shape without an n8n account, paid plan, provider credential, or customer data. Nova runs the same bounded demonstration and records the result in the existing project-scoped Activity ledger.

The local customer-audit engine now accepts a canonical owner-authorised export, requires a 32-byte HMAC identity key, fails closed if the expected 1,991 profiles are not present, and returns only pseudonymous duplicate clusters and aggregate contact, inactivity, booking, eligibility and delivery evidence. Raw names, emails, mobile numbers and Fresha identifiers are not returned. Header inspection reads only the first CSV row and reports that zero customer rows were read.

Capacity is derived from shifts, services and blocks rather than from a single occupied-minute total. Long or evidence-free `Walk-in` entries are treated as ambiguous blocked time: they are neither customer appointments nor offerable availability until reviewed. The detailed target-database contract is in `docs/sharp-cuts-customer-migration-contract.md`; it reuses the existing `sharp-cuts-team-preview` Neon project and has not been applied.

## Verified Fresha boundary

- Fresha exports client lists in CSV or Excel and appointment results in PDF, CSV, or Excel.
- Fresha already provides appointment reminders, updates, waitlist notifications, rebooking/win-back messages, campaigns and performance reporting. Nova must inspect the live workspace settings before enabling anything that could duplicate those notifications.
- Fresha's supported automated external data path is its paid, one-way Snowflake Data Connector. The public help and pricing material does not establish a general public transactional API for this use case.
- The Data Connector is a paid add-on and is unnecessary for the first owner-approved aggregate pilot. Its exact UK account checkout price must be confirmed before any purchase.

Sources:

- https://www.fresha.com/help-center/knowledge-base/clients/58-export-your-client-list
- https://www.fresha.com/help-center/knowledge-base/reports/191-export-reports
- https://www.fresha.com/help-center/knowledge-base/calendar/167-send-appointment-reminders
- https://www.fresha.com/help-center/knowledge-base/calendar/125-automated-messages-overview
- https://www.fresha.com/help-center/knowledge-base/reports/432-data-connector-overview
- https://www.fresha.com/pricing

## Tool decision

For the first live pilot, Nova should not add n8n yet. A manually initiated, owner-authorised aggregate Fresha export can prove segmentation, suppression and outcome reconciliation at zero recurring platform cost. After the input schema and cadence are stable, n8n Cloud is the simplest low-maintenance scheduled option; self-hosting adds patching, backups, uptime, secret management and monitoring. Current vendor pricing must be rechecked immediately before approval.

The zero-spend path is the checked-in inactive n8n workflow plus Nova's deterministic dry-run and owner-reviewed manual inputs. A live n8n account is not created and recurring spend is not enabled in this phase.

Sources:

- https://n8n.io/pricing/
- https://docs.n8n.io/

## Compliance gates

Every promotional candidate must have a recorded basis for the intended channel, be checked against the latest suppression list, contain a simple opt-out route, and remain pending until the owner approves the exact audience and message. Unknown consent fails closed. The system stores only the minimum suppression identifier needed to avoid future contact.

The prepared win-back proposal now binds an immutable audience-snapshot hash, copy, channel, recipient count and proposal hash to the future `sharp_cuts_campaign_send` approval action. No formal Approval is created from synthetic data, and no sender is connected. A real Approval can be prepared only after the 1,991-profile audit produces a lawful, suppression-checked exact audience.

Sharp Cuts social content can already use the project-scoped Social Engine draft, review, schedule and Activity records. The current Instagram OAuth token record is owner-scoped rather than project/account-scoped, however, so connecting Sharp Cuts today could replace or confuse the existing Nova Digital Services UK Instagram connection. Sharp Cuts Instagram must remain disconnected until a separately reviewed multi-account/project-scoped token migration is implemented and the owner grants the required Meta account permission. Owned barbershop footage must carry an explicit rights declaration before a Reel can become review-ready.

Sources:

- https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/respect-peoples-preferences/
- https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-checklist/
- https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/

## Prioritised backlog

1. Owner approves a header-only Fresha client/appointment export so Nova can validate the fields without retaining customer rows.
2. Produce aggregate 30/45/60/90-day counts, contact-channel coverage, suppression/consent coverage, duplicate count and future-booking exclusions. Record-level import remains a separate approval.
3. Use free email first for an exact owner-reviewed win-back audience and copy; paid SMS/WhatsApp remains disabled until its incremental value is proven.
4. Use Fresha's existing waitlist and last-minute Deals surfaces before building any parallel empty-slot messaging.
5. Add encrypted customer identity storage, retention policy, lawful-basis/suppression provenance and a DPIA-style data-flow review before any live record-level import.
6. Reconcile bookings, opt-outs, delivery and attributable rebooking revenue before repeating a campaign.
7. Add no-show/cancellation monitoring only after the available report fields are verified and without duplicating enabled Fresha reminders.
8. Add n8n scheduling only after the manual pilot proves value and input stability.

## Loyalty recommendation

Do not buy Fresha loyalty in the initial phase. If the owner wants a pilot, use an independent QR-enrolled Apple/Google Wallet stamp card with staff-authenticated stamping, one stamp per completed paid appointment, an immutable ledger, and owner-only corrections. Do not use a publicly reusable self-stamp QR. Current entry prices found during the assessment were Loopy Loyalty Starter at USD 25/month (or USD 250/year), Stamp Me UK Lite at GBP 39/month, and PassKit from USD 39.50/month. Recheck provider terms and UK tax before purchase.

No booking migration, message send, customer import, provider account, subscription, or Production deployment is part of this phase.

## Operational foundation completed locally

The command-centre workflow now prepares all four inactivity bands in a fixed priority order: 90+ days, 60–89 days, 45–59 days, then 30–44 days. Each band has independent email and SMS eligibility snapshots. Unknown marketing basis, suppression, future bookings, and missing channel data fail closed. Exact audience and copy remain bound to a future formal Approval, and there is no automatic send or retry.

The retained real audit is aggregate-only. It found 1,530 profiles in the 90+ band, 27 in 60–89, 24 in 45–59, and 17 in 30–44, but it did not contain verified marketing consent, suppression, or current delivery reachability. Those counts are planning evidence, not lawful send audiences. Nova must obtain an authorised eligibility source before it can produce a real approval card.

The migration-ready source contract is complete: HMAC customer identities, encrypted contact envelopes, immutable source/audience hashes, provenance, owner-reviewed merge candidates, and separate consent/suppression history. No identifiable record has been imported, the candidate Neon relationship is still awaiting owner confirmation, and the existing Sharp Cuts Web schema must not receive a bulk Fresha import unchanged.

The social workflow has project-scoped stages for rights-verified footage, 9:16 Reel, Story and offer cut-downs, monthly clip reuse, playable owner review, immutable version approval, scheduling and metrics. Instagram, Facebook and TikTok remain draft-only and disconnected for Sharp Cuts. Genuine owned shop footage is the required next input; no placeholder is treated as publishable content.

Email and SMS are prepared as disconnected approval-gated channels. WhatsApp is explicitly manual-app-only because no paid API is authorised. Empty-slot promotions remain blocked until staff availability is certified, the loyalty proposal remains inactive under the £0 subscription budget, and campaign performance accepts only provider-backed delivery, booking and revenue evidence.
