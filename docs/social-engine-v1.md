# Nova Social Engine V1

This Preview foundation reuses Nova's projects, evidence-backed research, PostgreSQL storage, formal approvals, Activity log, and persistent worker. It does not create a second agent or database.

## Safety state

- `NOVA_SOCIAL_LIVE_ENABLED` defaults to `false`.
- Drafting never publishes.
- Every publication is bound to the exact content SHA-256, caption, declared media, selected platforms, and scheduled time shown in the existing approval UI.
- Media must use a public HTTPS URL and declare `owned`, `licensed`, `permissioned`, or `public_domain` rights.
- Factual content cannot become review-ready without retained source references. Originality must pass separately.
- Provider ambiguity becomes `uncertain`; Nova does not retry automatically and risk a duplicate post.
- No Meta token or identifier is returned to the browser or written to Activity.

## Current format support

| Platform | Text | Image | Reel/video | Story |
| --- | --- | --- | --- | --- |
| Facebook Page | Yes | One image | Not enabled in V1 | Not enabled in V1 |
| Instagram professional account | Media required | One image | One public video URL | One public video URL |

Instagram video publishing creates a media container, polls its bounded processing state until `FINISHED`, then calls `media_publish`. The public media host and Meta account must satisfy Meta's current requirements.

## Server-only Preview configuration

All four Meta values must be configured together:

- `NOVA_META_GRAPH_API_VERSION`
- `NOVA_META_FACEBOOK_PAGE_ID`
- `NOVA_META_INSTAGRAM_ACCOUNT_ID`
- `NOVA_META_PAGE_ACCESS_TOKEN`

When Meta's Page-linking workflow is unavailable, `NOVA_META_INSTAGRAM_LOGIN_ACCESS_TOKEN` may hold a separate server-only Instagram User token. Nova then keeps Facebook Page publishing on `graph.facebook.com` while using Meta's officially supported Instagram Login path on `graph.instagram.com`; the Instagram account does not need to be linked to the Page. Tokens are never returned to the browser or Activity.

Keep `NOVA_SOCIAL_LIVE_ENABLED=false` until the owner has verified the exact Page, Instagram professional account, token permissions, media rights, and one controlled publish/reconciliation test.

Phase 2 stores Meta authorization by owner, Nova project, provider, and verified provider account. The existing Nova Digital Services UK Instagram Login record is copied unchanged into its project scope by schema migration 29; its encrypted token is neither decrypted nor replaced. Sharp Cuts uses a separate Facebook Login app configuration and encryption key:

- `NOVA_SHARP_CUTS_META_APP_ID`
- `NOVA_SHARP_CUTS_META_APP_SECRET`
- `NOVA_SHARP_CUTS_META_OAUTH_REDIRECT_URI`
- `NOVA_SHARP_CUTS_META_TOKEN_ENCRYPTION_KEY`
- `NOVA_SHARP_CUTS_META_INSTAGRAM_ACCOUNT_ID`
- `NOVA_SHARP_CUTS_META_FACEBOOK_PAGE_ID`

All six Sharp Cuts values are required together and belong in server-only Preview configuration. Nova accepts the authorization only when the official API returns both the configured `@sharpcuts.uk` Instagram professional account and the configured `Sharp Cuts Gents Barbers` Page. A provider account already bound to another Nova project is rejected. OAuth state is single-use, session-bound and expires after ten minutes. Tokens are AES-256-GCM encrypted with the project-specific key.

The minimum requested scopes are deliberately narrow. Facebook Page publishing/measurement uses `pages_manage_posts`, `pages_read_engagement`, and `read_insights`. Instagram Login uses `instagram_business_basic` and `instagram_business_content_publish`; the fallback Page-linked path uses `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, and `pages_read_engagement`. Nova does not request advertising, messaging, comment moderation, or public-content discovery permissions for Social V1.

## Scheduling model

The existing persistent worker polls `/api/admin/worker/social/tick` only after normal durable-task dispatch is idle. That is sufficient for local/Preview certification, but it is not an always-on production scheduler when the owner's computer is off. A managed always-on worker or scheduler remains a separate deployment and cost authorization boundary.

## Content pipeline

1. Use Nova's existing evidence-backed Web research for factual ideas.
2. Create a project-scoped `social_content_draft` with citations, originality status, and rights-declared media.
3. Retrieve `social_content_current` to display the immutable envelope.
4. Request `social_schedule_publish`; the generic formal approval card displays the exact publication.
5. After owner approval, store one idempotent scheduled publication.
6. The durable worker submits the exact content and records completion or safe failure in Activity.

The Social Command Centre now filters by project and shows content state, pending formal publication approvals, and social Activity history in one place. It also exposes an explicit verified-metrics readiness state; it never substitutes estimates for platform data.

The launch-batch control creates five idempotent English Instagram Reel plans for the `nova-digital-services-uk` project: two AI/technology explainers, two original AI/automation experiments, and one Nova project/service concept. Every plan contains a hook, complete 30-second script, shot list, caption, zero-cost production estimate, and reusable 9:16 template. They remain `draft` until a rights-declared video is attached; a script or static placeholder cannot accidentally become review-ready for Reel publication. Facebook derivatives stay a separate later step because Social V1 currently supports Facebook text/image publishing but not the Page Reels upload protocol.

An explicit metrics refresh reads follower and media totals from the official Meta API and persists a project-scoped timestamped snapshot. The dashboard labels values as verified only after a successful provider read. It never estimates missing values.

## Organic audience-growth operating plan

Nova Digital Services UK's primary sequence is Reels-first: practical AI demonstrations, small-business automation before/after examples, and concise technology explainers. Each idea becomes a sourced script, an original hook/storyboard, rights-cleared media, caption variants, and a review-ready immutable draft. The owner approves the exact publication; publishing remains disabled until the exact Meta Page and connected Instagram professional account are verified.

The repository currently contains only `assets/nova-mark.svg`; it contains no reusable footage, voice-over, music, or finished short-form video. The logo is reusable as a light end-card/brand element, but it is not enough to manufacture an engaging Reel. The lowest-cost dependable production path is owner-recorded screen captures or phone footage, edited with reusable subtitle/end-card templates. Optional AI stills or narration are generated only for an approved draft and against a per-item budget. No video-generation subscription is assumed.

Verified growth reporting will retain platform snapshots for followers, reach, Reel/video views, engagements, and published-content identifiers only after official read permissions and exact asset identity are confirmed. TikTok remains a future Content Posting API integration (an unaudited client is private-only); YouTube Shorts remains a future OAuth `youtube.upload` integration. Neither is represented as available today.

Cloud scheduling is not complete in Preview: the protected tick endpoint and PostgreSQL leases are cloud-safe, but the current poller is the owner's persistent Windows worker. Vercel Cron targets the production deployment, so enabling it would cross the explicit Production boundary. The two honest next choices are a later owner-authorized Production Vercel Cron or a small always-on/scheduled cloud worker with an approved recurring cost. Until then, the dashboard must show `cloudScheduler: false` and cannot claim laptop-independent publication.
