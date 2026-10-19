# Sharp Cuts growth and retention assessment — 2026-10-18

This assessment records only safe aggregates from the live Fresha workspace and public provider information. No customer record was exported or retained, no message was sent, and no setting was changed.

## Verified live aggregates

- Fresha is the live booking and customer source of truth.
- Client profiles: 1,991. Fresha reports that duplicate profiles exist, but the exact duplicate count was not exposed in the aggregate view.
- Client segments: new 9, recent 200, first visit 1, loyal 124, lapsed 1, high spenders 15, upcoming birthdays 21, booked online 1,544, upcoming appointments 48, and sales in the last 30 days 103.
- The standard client report exposes mobile, email, added date, first appointment, last appointment and source fields. Exact mobile/email completeness, invalid contacts, opt-outs and 30/45/60/90 inactivity bands require an owner-approved aggregate or header-only export workflow.
- Today's aggregate occupancy was 85%. The next seven days showed 56 scheduled appointments with GBP 1,338 scheduled value. Per-barber underbooking was not inspected because the relevant richer reporting is a premium surface and could expose staff-level detail.
- Enabled automation includes the 24-hour appointment reminder, appointment changes, cancellation/no-show, visit/tip thanks, waitlist joined and slot-available, rebooking reminder, and chat notifications.
- Birthday, lapsed-client win-back, loyal-client reward, new-client welcome and loyalty messages were disabled.
- Year-to-date 24-hour-reminder reporting showed 5,830 sent and 3,246 confirmed delivered: email 2,845/2,822, SMS 125/20, and WhatsApp 2,860/404. Unconfirmed is not treated as failed because aggregate failure reasons were unavailable.
- Communications balance was GBP 0 and automatic top-up was off. This prevents unapproved paid use; it does not prove whether every enabled automation is blocked because free allowances and channel fallbacks apply.

## Non-duplication decision

Nova must not recreate enabled transactional reminders, waitlist notifications or rebooking reminders. The first Nova workflow is a read-only 30/45/60/90-day decision layer that prepares an exact owner-reviewed audience, excludes upcoming bookings and suppressed/unverified contacts, and recommends free email first. Fresha's own waitlist, appointment assignment and last-minute Deals should be used before any separate slot-filling sender.

## Known Fresha UK communication prices

The inspected/public pricing evidence supports: marketing email GBP 0.02, marketing SMS GBP 0.08, automated SMS GBP 0.06, and automated WhatsApp GBP 0.05–0.10 per message, before VAT, after applicable allowances. The account had a zero balance and auto top-up disabled. The exact remaining allowance and eligible bookable-member count were not safely provable from the available read-only surfaces.

## Compliance boundary

UK electronic marketing requires consent or a properly evidenced existing-customer soft opt-in for similar services, with an opt-out at collection and in every message. Suppressed contacts must remain on a minimal do-not-contact list. Owner acceptance of a campaign cannot replace missing lawful-basis evidence.

## Cheapest evidence-producing next step

Approve a header-only plus aggregate Fresha export workflow. Nova first validates field names and reports only counts: duplicates, channel coverage, consent/suppression coverage, 30/45/60/90 inactivity, upcoming-booking exclusions and first/returning status. Only after reviewing those aggregates should the owner separately approve a minimal record-level import, retention policy, exact audience and exact copy. No n8n subscription is needed for this first proof.
