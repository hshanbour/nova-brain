# Sharp Cuts WhatsApp Coexistence preparation — 31 October 2026

## Decision

Use Gupshup's official self-serve WhatsApp Business App Coexistence route for `+44 1582 510565` for the first owner-controlled test. It has no monthly subscription or billing commitment. Meta must still show the existing app account as eligible during Embedded Signup.

- The existing Twilio WhatsApp adapter is not suitable for this number because its supported onboarding path does not preserve concurrent use of the WhatsApp Business App.
- Gupshup documents Coexistence, inbound webhooks, message echoes, an authenticated send API and published webhook source IPs.
- 360dialog remains the paid fallback if Gupshup rejects eligibility or cannot deliver reliable Coexistence events; its regular tier is €49/month plus Meta charges.
- Respond.io adds a broader team-inbox platform and a higher fixed platform subscription. Nova already has the durable queue, AI, monitoring and approval boundary, so that duplication is not justified.
- n8n does not remove the provider, eligibility, webhook, consent or billing requirements and is not required for the first connection.

Official evidence:

- https://bizgate-docs.gupshup.io/docs/what-is-coexistence
- https://docs.gupshup.io/docs/overview
- https://support.gupshup.io/hc/en-us/articles/56952275875097-IP-Addresses-for-Webhook-Delivery
- https://docs.gupshup.io/reference/session-text-message
- https://www.twilio.com/docs/whatsapp/migrate-numbers-and-senders

## Prepared Nova boundary

- Fixed project: `sharp-cuts-web`.
- Fixed verified number: `+44 1582 510565`.
- Primary provider: `gupshup_coexistence`; paid fallback: `360dialog_coexistence`.
- Inbound Gupshup events require a Vercel-verified provider source IP or a private bearer used only for local verification.
- Exact Gupshup app ID and Meta phone-number ID are checked before accepting an event.
- Project-prefixed conversations and project-filtered worker claims.
- Encrypted contact binding; raw phone numbers and message bodies are excluded from activity logs.
- Inbound text is durable and idempotent.
- AI uses only a small server-verified Sharp Cuts profile and the current conversation; owner memory, tools and other projects remain unavailable.
- `draft_only` stops at owner review. `owner_test` can send only to exact E.164 numbers in the test allowlist.
- Campaigns and unrestricted automatic replies remain disabled.
- Exact STOP/UNSUBSCRIBE/CANCEL/END/QUIT messages are captured without an automated reply.
- Business App echo events are recorded as human activity without storing their content in activity logs.
- The preserved WhatsApp Business App remains the human-takeover interface.

## Mandatory stop conditions during onboarding

Stop if Meta or the provider proposes standard migration, deletion/re-registration, loss of the existing number/history, unexpected portfolio/WABA ownership transfer, payment, wallet top-up or any subscription. Do not use an unofficial WhatsApp Web/local bridge.

## Owner-controlled onboarding checkpoint

Create or sign into the official Gupshup self-serve account, create one WhatsApp Access API app, choose the existing WhatsApp Business App/Coexistence path and stop at Meta authentication. The owner must select the existing Sharp Cuts portfolio and confirm Meta explicitly offers Coexistence for `+44 1582 510565`. No wallet top-up or customer messaging is authorised. After onboarding, configure only one owner-controlled number in Nova's test allowlist and send one inbound test message.
