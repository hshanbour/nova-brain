# Sharp Cuts Fresha reconciliation readiness — 29 October 2026

## Safe evidence reviewed

- The authenticated Sharp Cuts Fresha account was inspected read-only. No profile, setting, booking or automation was changed and no export was created.
- Fresha currently exposes standard **Client list** and **Appointments list** reports, plus aggregate Appointments, cancellations/no-shows, Waitlist, Working hours, Break activity, Scheduled shifts and Team time-off reports.
- The retained owner-approved client export contains 1,988 rows against 1,991 profiles shown in Fresha. It contains email presence, mobile presence and `Last appt.` only.
- The retained export does **not** contain an authoritative customer/profile ID, marketing-consent decision or source, opt-out/suppression state, email/SMS/WhatsApp delivery evidence, or a certified future-booking flag.
- A future-dated `Last appt.` proxy identifies 55 rows; the Fresha-native segment previously showed 56. This unresolved one-record difference is preserved rather than guessed.

## Fail-closed channel reconciliation

| Channel | Address present | Verified consent | Verified suppression | Verified deliverability | Verified campaign-eligible |
|---|---:|---:|---:|---:|---:|
| Email | 1,571 | 0 | 0 | 0 | 0 |
| SMS | 1,649 mobile numbers | 0 | 0 | 0 | 0 |
| WhatsApp | 1,649 mobile numbers | 0 | 0 | 0 | 0 |

Contact presence is not permission or reachability. Email consent cannot be reused for SMS or WhatsApp, and mobile presence does not prove WhatsApp availability.

## Sender preparation boundary

- `Sharp Cuts <info@sharpcuts.uk>` remains the dedicated sender identity.
- No Fresha contact is uploaded to Sender and no campaign is sent.
- Before Nova can create a formal send approval, the exact audience snapshot must reconcile: authoritative source ID, consent and its source/time, current channel-specific opt-out/suppression, channel reachability, future-booking exclusion and exact-address deduplication.
- Sender's provider suppression state must then be reconciled with the source-of-truth audience; suppression always wins.

## Next supported owner action

Obtain a supported Fresha report or Fresha Support confirmation that exposes consent/source and suppression/opt-out fields for the exact 90+ day cohort, together with an authoritative upcoming-booking exclusion. If Fresha cannot provide these fields, the first real campaign must use a separately evidenced permission source rather than the current client export. Until then, Nova must report zero verified sendable recipients.
