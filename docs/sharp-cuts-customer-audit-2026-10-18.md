# Sharp Cuts Fresha customer audit — 18 October 2026

## Scope and controls

- One-time, local, read-only analysis of the owner-approved Fresha client-list and appointment-list exports.
- Raw files were held only in the owner-restricted local audit directory during processing.
- No identifiable customer data was written to this report, Nova memory, Neon, Git, or any cloud service.
- Marketing consent, suppression, delivery reachability, and permission to contact remain `UNKNOWN` because the approved exports do not contain authoritative fields for them.
- No messages were sent and no Fresha, booking, customer, or deployment state was changed.

## Source coverage

- Fresha UI client total: **1,991**.
- Client rows present in the generated CSV: **1,988** (**99.85%**).
- Unexplained export difference: **3 profiles**. These profiles are not silently counted as audited.
- Appointment rows present in the all-time generated CSV: **1,486**.
- Appointment scheduled-date range: **1 August 2026 to 18 October 2026**.

## Customers and potential duplicates

- Exported customer profiles analysed: **1,988**.
- Exact email/mobile connected components: **1,652**. This is a conservative technical grouping, not an assertion that shared-contact profiles are the same person.
- Potential exact-contact duplicate components: **217**, covering **553 profiles**.
- Potential same-normalised-name groups: **241**, covering **619 profiles**. Name matches are candidates only and require owner review; they were not merged.

## Contact coverage

- Email present: **1,571**; missing: **417**.
- Mobile present: **1,649**; missing: **339**.
- Both email and mobile present: **1,569**.
- Both email and mobile missing: **337**.
- Marketing consent: **UNKNOWN**.
- Suppression/opt-out status: **UNKNOWN**.
- Actual email/SMS/WhatsApp reachability: **UNKNOWN**.
- Eligible to message: **UNKNOWN**; no permission to contact is inferred from contact presence.

## Inactivity and visit history

- Active under 30 days: **141**.
- Inactive 30–44 days: **17**.
- Inactive 45–59 days: **24**.
- Inactive 60–89 days: **27**.
- Inactive 90+ days: **1,530**.
- No visit history in the export: **194**.
- Future-dated values in Fresha's `Last appt.` field: **55**. These are excluded from inactivity bands and are not treated as verified upcoming-booking status.
- Profiles with a first appointment date: **1,794**.
- Profiles with a last appointment date: **1,794**.
- Earliest first appointment: **13 June 2018**.
- Upcoming-booking status: **UNKNOWN** from the approved client export.

## Appointment activity and Walk-In treatment

- Appointment rows: **1,486**.
- Status totals: **525 completed**, **809 new/open**, **24 no-show**, **128 cancelled**.
- Named-customer rows: **1,184**.
- Named completed visits: **480**.
- Named no-shows: **24**.
- Named cancellations: **110**.
- Named future/open rows: **570**.
- Ambiguous `Walk-In` rows: **302**, totalling **68,920 minutes**.
- Long ambiguous `Walk-In` rows of 120+ minutes: **148**, totalling **62,265 minutes**.
- All `Walk-In` rows are excluded from verified customer occupancy in this audit. Long rows are treated as probable block/unavailability candidates, not genuine appointments or offerable time.

## Safe source for staff availability

Fresha exposes separate aggregate reports named **Break activity**, **Scheduled shifts**, **Working hours activity**, and **Team time off report**. Those reports are the appropriate candidate sources for staff calendar blocks and unavailable time. They were not exported because that additional data category was not part of the two approved exports. Available-slot calculations therefore remain **NOT CERTIFIED**.

## Validation and retention

- Focused customer-audit and occupancy regressions: **11 passed, 0 failed**.
- Aggregate consistency checks passed: inactivity buckets total 1,988; appointment statuses total 1,486; named plus ambiguous Walk-In rows total 1,486.
- Audit integrity hash: `437aad0ae9e333cdfe017997b82d299d9aeb8b567e102b6a98cf4a6782beb7b2`.
- This document contains aggregate counts only and no direct customer identifiers.
