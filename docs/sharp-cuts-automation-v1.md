# Sharp Cuts Growth & Automation V1

## Selected first workflow

The first workflow is a read-only 30/45/60-day retention monitor. It consumes an owner-authorised Fresha-style export, excludes customers with a future booking, applies suppression and electronic-marketing-basis gates, and prepares recommendations for owner review. It never sends a message.

The checked-in n8n workflow is deliberately inactive and synthetic. It proves the orchestration shape without an n8n account, paid plan, provider credential, or customer data. Nova runs the same bounded demonstration and records the result in the existing project-scoped Activity ledger.

## Verified Fresha boundary

- Fresha exports client lists in CSV or Excel and appointment results in PDF, CSV, or Excel.
- Fresha already provides appointment reminders, updates, waitlist notifications, rebooking/win-back messages, campaigns and performance reporting. Nova must inspect the live workspace settings before enabling anything that could duplicate those notifications.
- Fresha's supported automated external data path is its paid, one-way Snowflake Data Connector. The public help and pricing material does not establish a general public transactional API for this use case.
- The Data Connector is a paid add-on. Its current public pricing page lists 295 USD per location per month; the actual UK account checkout price and currency must be confirmed before purchase.

Sources:

- https://www.fresha.com/help-center/knowledge-base/clients/58-export-your-client-list
- https://www.fresha.com/help-center/knowledge-base/reports/191-export-reports
- https://www.fresha.com/help-center/knowledge-base/calendar/167-send-appointment-reminders
- https://www.fresha.com/help-center/knowledge-base/calendar/125-automated-messages-overview
- https://www.fresha.com/help-center/knowledge-base/reports/432-data-connector-overview
- https://www.fresha.com/pricing

## Tool decision

For the live pilot, n8n Cloud Starter is the fastest low-maintenance option after owner approval: the current public price is 20 EUR per month billed annually for 2,500 workflow executions. Self-hosted Community Edition removes the n8n subscription but adds patching, backups, uptime, secret management, and monitoring. It is not cheaper in operational risk for this small first deployment unless Nova already has a suitable persistent container host.

The zero-spend interim path is the checked-in n8n workflow plus manual Fresha exports. A live n8n account is not created and recurring spend is not enabled in this phase.

Sources:

- https://n8n.io/pricing/
- https://docs.n8n.io/

## Compliance gates

Every promotional candidate must have a recorded basis for the intended channel, be checked against the latest suppression list, contain a simple opt-out route, and remain pending until the owner approves the exact audience and message. Unknown consent fails closed. The system stores only the minimum suppression identifier needed to avoid future contact.

Sources:

- https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/respect-peoples-preferences/
- https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-checklist/
- https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/

## Prioritised backlog

1. Owner imports `sharp-cuts-web` into Nova so the command centre has its authoritative project identity.
2. Owner exports a field-header-only Fresha client and appointment sample. Nova validates the schema without retaining customer rows.
3. Confirm the live Fresha reminder, rebooking/win-back, waitlist and campaign settings to create a non-duplication matrix.
4. Choose manual scheduled exports for the pilot or separately approve Fresha Data Connector and n8n Cloud.
5. Add encrypted customer identity storage, retention policy, lawful-basis/suppression provenance, and a DPIA-style data-flow review before any live import.
6. Run retention monitoring with a dry-run aggregate report, then prepare exact formal approvals for any promotional audience and copy.
7. Add no-show, cancellation and empty-slot read models only after the available Fresha fields are verified.
8. Add outcome reconciliation and campaign attribution before expanding automation volume.

No booking migration, message send, customer import, provider account, subscription, or Production deployment is part of this phase.
