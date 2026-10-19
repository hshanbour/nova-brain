# Sharp Cuts marketing eligibility audit — 19 October 2026

## Scope and privacy

- Source: one owner-approved, all-time Fresha client-list export, processed locally.
- Export rows: 1,988; Fresha's live Client List UI reported 1,991 profiles.
- Inspected fields: email presence, mobile presence, and `Last appt.` only. The export did not provide a profile ID, marketing-consent source, opt-out/suppression, or delivery-status field.
- Names and contact values were not retained in this report or the aggregate result.
- Contact presence was not treated as consent or confirmed reachability.
- No messages were sent, no Fresha data was changed, and no identifiable data was imported into Nova or Neon.

## Classification policy

- **Eligible:** consent/source, suppression state, channel reachability, and campaign conditions are verified. No record met this standard with the available fields.
- **Unknown:** the channel address/number exists, but consent, suppression, and delivery evidence are unavailable.
- **Blocked — missing channel:** no address/number exists for that channel. This does not assert an opt-out or suppression.
- `future_or_upcoming` uses a future-dated `Last appt.` value as a record-level proxy. The live Fresha custom segment showed 56 clients with upcoming appointments, while this export contained 55 future-dated records. The discrepancy is retained as a freshness/definition difference; no profiles were opened to reconcile it.

## Aggregate audit

Every `eligible` value is zero. Cells below are `unknown / blocked-missing-channel`.

| Activity group | Profiles | Email | SMS | WhatsApp |
|---|---:|---:|---:|---:|
| Active under 30 days | 134 | 122 / 12 | 126 / 8 | 126 / 8 |
| Inactive 30–44 days | 21 | 19 / 2 | 20 / 1 | 20 / 1 |
| Inactive 45–59 days | 25 | 21 / 4 | 22 / 3 | 22 / 3 |
| Inactive 60–89 days | 28 | 19 / 9 | 23 / 5 | 23 / 5 |
| Inactive 90+ days | 1,531 | 1,169 / 362 | 1,229 / 302 | 1,229 / 302 |
| No visit history | 194 | 170 / 24 | 177 / 17 | 177 / 17 |
| Future/upcoming proxy | 55 | 51 / 4 | 52 / 3 | 52 / 3 |
| **All exported rows** | **1,988** | **1,571 / 417** | **1,649 / 339** | **1,649 / 339** |

Mobile presence is not evidence that WhatsApp is available for the person. Accordingly, all 1,649 mobile-present records remain unknown for WhatsApp.

## Win-back boundary

- Verified eligible: email 0; SMS 0; WhatsApp 0.
- Verified opt-out/suppression blocks: unknown because the relevant fields are absent.
- Provider delivery evidence: unavailable in the approved export.
- No campaign audience may be sent from this audit alone.

## Smallest practical next step

Request separate approval to create, but not send, one Fresha-native 90+ day custom segment and campaign draft. Fresha can then apply its own current consent, opt-out, suppression, and provider-deliverability rules and expose a provider-calculated audience before the owner reviews the exact offer, cost, and recipients. Stop before sending. If Fresha cannot expose those exclusions, obtain an official consent/suppression export or support confirmation before any outreach.
