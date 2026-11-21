# Hosted Fresha executor checkpoint — 21 November 2026

## Latest verified state — 13:56 UTC (supersedes the initial handoff below)

- Hosted owner login succeeded. The worker verified Sharp Cuts and location 139805. Login survived subsequent machine restarts/deployments without another sign-in.
- Temporary login flag is false, remote port 6080 was verified closed, and Fly proxy session 25305 ended. Temporary Codex-readable credential copy was deleted. The noVNC tab was closed.
- Local dedicated Fresha worker session 23622 was stopped. The general Windows worker and old queues were not changed.
- Actual Nova UI catalogue request `fresha_op_9ec387fe6f7edaceeac41066dd50c20869008be9` completed at 13:47:04 UTC: 10 services, prices/durations, three staff (Abu yasser, Hamood, Rovand).
- Actual multi-turn Nova UI request returned live Hamood haircut availability on 21 November through the hosted worker: `fresha_op_864dbf0f20150f38bce7febce99e6bddd0fa6b00`. Eleven slots were observed: 14:40, 14:50, 15:00, 15:10, 16:10, 16:20, 16:30, 16:40, 16:50, 17:00, 17:10 GMT. These are dated observations, not reservations or current guarantees.
- Provider selector snapshot independently confirmed the selected date, Hamood and all eleven times. This proves cloud-only live read execution and result return, not cloud appointment writes or long-term reliability.
- Repairs: keep automated browser navigation suspended during temporary owner login; read staff list and accessible service names correctly; supply the existing model provider's required empty customer-scoped context; wait for actual slots or an explicitly matched empty-state message.
- The earlier unanchored empty-state regex could match “no beard trim” before slots loaded. Two resulting empty receipts are now exposed as blocked/unverified unless they contain positive empty-state evidence; records remain preserved. Do not use those two results to assert 21/22 November is fully booked.
- Connected Preview commit `bea8592`; hosted image `deployment-01M7Z65CCHWP201FMQV4J3QXDH`. Later UI-only commit adds readable persisted availability receipts.
- Automated checks: latest affected group 13 passed. Actual live proof is the UI/cloud/provider chain above, separately from tests.
- General customer booking writes, verified customer-to-appointment binding, reminder dispatch, and a newly approved hosted write lifecycle remain incomplete/inactive. No new appointment, campaign, customer notification or historical-queue release occurred in this hosted-read pass.

## Verified deployment and safeguards

- Owner approved one private London Fly Machine: shared 2 CPUs, 2 GB RAM, 3 GB encrypted persistent profile volume, estimate USD 15.64 per 730 hours plus traffic/tax. No public service/IP or second machine.
- App: `nova-sharp-cuts-fresha-executor`; existing Yahoo account, personal organisation.
- Machine `84eee35ced9e48`; volume `vol_458w3ynex33y5lq4`.
- Existing worker and Vercel bypass credentials transferred directly to Fly secrets without printing values. No keys rotated.
- Cloud worker heartbeat observed in the signed-in Nova booking operations page at 13:28:49 UTC. State `sign_in_required`, hosted. This proves cloud polling, not authenticated Fresha operation.
- Preview commit `0449f31` deployed and assigned to the existing connected branch alias. Production untouched.
- One catalogue read requested through Nova; remains held until the hosted browser signs in. No new booking writes or outbound sends enabled.
- Preserved original lifecycle: appointment `1830348930`, created/read back, rescheduled, cancelled/read back on 21 November. Do not repeat or mutate that historical test.

## Temporary login handoff

- Owner explicitly approved temporary password-protected remote browser access over the authenticated Fly tunnel, then single-file Codex read permission for its temporary password handoff.
- Loopback viewer: `http://127.0.0.1:16080/vnc.html`; remote port 6080 is not publicly exposed.
- The temporary handoff copy was deleted after entry. Original credential remains in the owner-restricted local secure folder and Fly secrets. No secret in this document, Git, chat, logs or clipboard.
- Actual hosted browser displayed `partners.fresha.com/users/login?redirectTo=%2Fcalendar`. A harmless invalid address was entered to verify keyboard delivery and then cleared without submitting.
- Owner login/MFA requested. Await result before reading the Sharp Cuts account/calendar.
- **After login:** disable `FRESHA_OWNER_LOGIN_ENABLED`, close the Fly proxy, verify remote viewing is disabled, and recheck persisted authentication. Do not leave temporary access enabled as the operating configuration.

## Next verification and remaining work

1. Verify correct Sharp Cuts business and location 139805 from the hosted browser.
2. Stop only the local dedicated Fresha worker, then complete queued live catalogue/availability reads through Nova and the hosted worker. Verify selectors against actual provider UI and correct defects before claiming live reads.
3. Verify login persistence through a controlled hosted restart. Stale profile locks, changed UI and expired authentication must hold work with explicit alerts.
4. The new generic customer conversation currently prepares reads only. Customer-to-appointment binding, generic write execution and reminder flows are NOT yet proven or enabled. Implement and verify them, then obtain one exact scoped live-test approval before new calendar writes/customer messages.
5. Never dispatch historical queues or modify existing appointments as a test. Current reminders and campaign sends remain disabled.

## Sender support evidence

The actual Sharp Cuts Gmail thread contains Lucas's reply of 20 November 22:41 UTC. Support says limits are under investigation and lists API request limits (Free 60/min, Standard 300/min, Professional 600/min). It does not identify the transactional `type=plan` allowance/reset or confirm that a 1,240-person campaign is unaffected. A connector search returned no messages but did not establish the Sharp Cuts mailbox state; the browser thread did.

No duplicate support email or test send was made. Preserve draft J6P5lD and exactly 1,240 transferred addresses. Respect the saved provider cooldown and reconcile prior outcomes before the single already-authorised Yahoo test.
