# Sharp Cuts WhatsApp Coexistence assessment — 29 October 2026

## Current safe conclusion

- Sharp Cuts continues to use the existing WhatsApp Business App number `+44 1582 510565`; its app service and conversations remain untouched.
- Nova has no project-scoped WhatsApp Cloud API credential or webhook for Sharp Cuts, and WhatsApp execution remains disabled.
- Business App/Cloud API Coexistence is the only acceptable onboarding path because ordinary number migration would risk changing the current app workflow.
- Eligibility cannot be conclusively pre-approved from a public endpoint. Meta/BSP onboarding must confirm that this exact Business App account and number are offered the Coexistence path before any change is accepted.

## Eligibility checks required at the official onboarding screen

1. The exact Sharp Cuts business portfolio and WhatsApp Business Account are selected.
2. The existing number is recognised as a WhatsApp Business App number and explicitly offered **Coexistence**, not migration/re-registration.
3. The mobile app remains active and existing conversation history is not represented as being deleted or transferred.
4. The chosen provider discloses its own recurring/platform fees before confirmation.
5. Nova receives only the narrow credentials and webhook events needed for the Sharp Cuts project.

Any migration, app disconnection, number re-registration, unexpected asset transfer, new subscription or payment step is a stop condition.

## Pricing and consent boundary

- Meta's current WhatsApp Business Platform pricing is per delivered message and varies by destination market and category (marketing, utility, authentication or service).
- Service replies inside the 24-hour customer-service window are currently free, and utility messages sent in response to users are also described as free by Meta. A customer entering from a click-to-WhatsApp ad or Facebook Page CTA creates a 72-hour free entry-point window.
- Marketing outreach remains a separately priced category and requires approved templates plus explicit WhatsApp opt-in. Fresha email consent or mere mobile-number presence is not WhatsApp consent.
- A BSP may add its own fee even where Meta's service messages are free. No BSP or paid service has been selected or authorised.

## Recommendation

Keep the current app-only operation. When the owner is ready, run one read-only/stop-before-confirmation Embedded Signup eligibility check with an official Meta-supported path or selected BSP. Capture the offered mode, asset identity and disclosed fees; do not complete onboarding until the owner separately approves those exact terms.
