# Sharp Cuts campaign review

**14 November 2026 · Nova draft `email-review-03168ffed66dee2dfd162bce`**

This is the existing draft in the original connected workspace. In Nova, ask to show the saved Sharp Cuts email draft. The `sharp_cuts_email_drafts` tool returns the stored copy and the HTML prepared for Sender. No send time or recipient transfer has been approved.

## Email

**From** Sharp Cuts &lt;info@sharpcuts.uk&gt;
**Reply-To** info@sharpcuts.uk
**Subject** Welcome back to Sharp Cuts — ready for a fresh look?

> Hi there,
>
> Ready for your next haircut? We would love to welcome you back to Sharp Cuts Gents Barbers. Choose your barber and book with our team here:
> [Book with the Sharp Cuts team](https://www.fresha.com/a/sharp-cuts-luton-uk-57-cheapside-p20zttw0)
>
> See you when you are ready,
> The Sharp Cuts team
> 57 Cheapside, Luton, LU1 2HN
>
> Unsubscribe

The final footer uses Sender’s recipient-specific `{$unsubscribe_link}`. The historical Nova draft retains its placeholder. The HTML review replaces it with the provider tag. A recipient-specific URL can only be checked after Sender renders one. [Sender campaign HTML response](https://api.sender.net/campaigns/get-one/)

## Recipient reconciliation

| Read-only source | Verified finding |
|---|---|
| Sharp Cuts restricted staging view | 1,562 distinct email-bearing profile IDs. 662 of these profiles have an ambiguous identity flag. |
| Original 19 October Fresha client export and its staged import | 1,988 rows, 1,571 rows with email and 1,558 distinct normalised email addresses. |
| Contact eligibility | The client report contains no evidence of marketing permission, historical opt-outs or current future bookings. Having an address alone did not clear anyone. |
| Last available Sender account read | One test group, one active subscriber, no campaign for this draft. A dedicated campaign group has not been bound to Nova. |

The audience preparation command verifies the original file digest and the current staging membership digest, counts each distinct address once, and checks the provider’s marketing subscription status. It holds source suppressions, future bookings, unresolved shared addresses, missing contactability evidence, and provider opt-outs or bounces. An active transactional email status does not clear a marketing opt-out. [Sender subscriber fields](https://api.sender.net/subscribers/list-all/)

**Release dependencies.** Reconcile the exact source list against authoritative email marketing permission, historical opt-outs, contactability and current bookings. Bind a dedicated Sharp Cuts campaign group after its scope is verified. Review the resulting eligible count, excluded counts, copy and send time before approving any send. The existing test group has a different purpose. No account-wide sending restriction was established by the available read-only checks.

**Tracking.** After a provider campaign ID exists, ask Nova for its Sharp Cuts email campaign tracking. The read-only result includes the provider’s status, schedule and send timestamps, sent count, opens, clicks, bounces and validation warnings when available. Recipient-level details stay out of the result. A sent count alone does not establish delivery. The saved draft has no provider campaign ID or measured delivery outcome. [Sender campaign details](https://api.sender.net/campaigns/get-one/) and [sent email records](https://api.sender.net/statistics/sents/)
