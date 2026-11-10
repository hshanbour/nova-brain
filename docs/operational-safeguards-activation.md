# Preview activation hold

This release is local and must not be pushed/deployed until application sign-in is integrated and tested. Vercel deployment protection is not per-user application identity.

Required server configuration: NOVA_CONSOLE_OIDC_ISSUER, NOVA_CONSOLE_OIDC_AUDIENCE, NOVA_CONSOLE_OIDC_JWKS_URL, NOVA_CONSOLE_OIDC_OWNER_SUBJECT. Use a real provider's immutable subject and verify its issuer/audience/JWKS. No caller-controlled owner/workspace headers or worker/bypass tokens qualify. Browser sign-in, token transport, reload and logout still need integration; these variables alone do not implement login. Bind the existing owner workspace only; deny other users. Verify isolated Preview DB/auth before provisioning. Do not edit Production.

Private owner phone access defaults false in Round 2; no activation callback is wired in createApp. Calibration and an explicitly authorised real call are prerequisites to a separate change.

Sharp Cuts WhatsApp execution and outbound default false independently: NOVA_SHARP_CUTS_WHATSAPP_EXECUTION_ENABLED and NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED. Leave both unset/false. Even with them enabled, project master+messaging and owner-test allowlist remain mandatory. Never replay the backlog during worker upgrade. Current installed worker 201c493 has no Sharp Cuts tick handler; this release tests the newer handler with isolated synthetic records only.

Query translation uses the existing budget-controlled intake model with strict bilingual JSON and a four-second bound. Only translations are cached; memory records remain live. Validate provider output and latency in fresh signed-in chat and Voice before calling multilingual retrieval live-verified.

315 focused tests passed. The broad suite retains unrelated historical planning fixture contradictions; see the local operational-safeguards report and .qa logs. No live customer messages, calls, database migrations or external account changes were performed.
