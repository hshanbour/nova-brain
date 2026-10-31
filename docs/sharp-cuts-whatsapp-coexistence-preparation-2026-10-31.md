# Sharp Cuts WhatsApp Coexistence preparation — 31 October 2026

## Decision

Use the official 360dialog WhatsApp Business App Coexistence route for `+44 1582 510565`, subject to Meta showing the number as eligible during Embedded Signup and the owner separately approving the paid channel activation.

- The existing Twilio WhatsApp adapter is not suitable for this number because its supported onboarding path does not preserve concurrent use of the WhatsApp Business App.
- 360dialog documents Coexistence, Business App message echoes, per-number API keys and authenticated custom webhook headers. Its transparent entry tier is €49 per number per month plus Meta message fees.
- Respond.io adds a broader team-inbox platform and a higher fixed platform subscription. Nova already has the durable queue, AI, monitoring and approval boundary, so that duplication is not justified.
- n8n does not remove the provider, eligibility, webhook, consent or billing requirements and is not required for the first connection.

Official evidence:

- https://docs.360dialog.com/docs/resources/phone-numbers/coexistence
- https://docs.360dialog.com/docs/hub/embedded-signup
- https://docs.360dialog.com/docs/get-started/pricing
- https://docs.360dialog.com/docs/messaging/webhook
- https://www.twilio.com/docs/whatsapp/migrate-numbers-and-senders

## Prepared Nova boundary

- Fixed project: `sharp-cuts-web`.
- Fixed verified number: `+44 1582 510565`.
- Provider: `360dialog_coexistence` only.
- Authenticated phone-number webhook using a private custom bearer header.
- Provider phone-number identity check before any event is accepted.
- Project-prefixed conversations and project-filtered worker claims.
- Encrypted contact binding; raw phone numbers and message bodies are excluded from activity logs.
- Inbound text is durable and idempotent.
- AI uses only a small server-verified Sharp Cuts profile and the current conversation; owner memory, tools and other projects remain unavailable.
- Initial mode is draft-only. AI drafts stop at `awaiting_owner_review`; there is no provider send implementation in this activation stage.
- Exact STOP/UNSUBSCRIBE/CANCEL/END/QUIT messages are captured without an automated reply.
- Business App echo events are recorded as human activity without storing their content in activity logs.
- The preserved WhatsApp Business App remains the human-takeover interface.

## Mandatory stop conditions during onboarding

Stop without confirming if Meta or the provider proposes standard migration, deletion/re-registration of the app account, loss of the existing number/history, an unexpected business/WABA ownership transfer, a plan other than the reviewed €49/month tier, or any new payment/charge.

## Owner-controlled onboarding checkpoint

Open 360dialog's official client signup and choose the **WhatsApp Business App / Coexistence** Embedded Signup route. The owner must log into Meta, select the existing Sharp Cuts business portfolio, and verify that Meta explicitly offers **Connect a WhatsApp Business app** for `+44 1582 510565`. Do not complete payment or the final connection until the eligibility screen and exact monthly/usage charges have been reviewed.
