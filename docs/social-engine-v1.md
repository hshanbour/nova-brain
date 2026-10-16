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

Keep `NOVA_SOCIAL_LIVE_ENABLED=false` until the owner has verified the exact Page, Instagram professional account, token permissions, media rights, and one controlled publish/reconciliation test.

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

## Organic audience-growth operating plan

Nova Digital Services UK's primary sequence is Reels-first: practical AI demonstrations, small-business automation before/after examples, and concise technology explainers. Each idea becomes a sourced script, an original hook/storyboard, rights-cleared media, caption variants, and a review-ready immutable draft. The owner approves the exact publication; publishing remains disabled until the exact Meta Page and connected Instagram professional account are verified.

The repository currently contains only `assets/nova-mark.svg`; it contains no reusable footage, voice-over, music, or finished short-form video. The logo is reusable as a light end-card/brand element, but it is not enough to manufacture an engaging Reel. The lowest-cost dependable production path is owner-recorded screen captures or phone footage, edited with reusable subtitle/end-card templates. Optional AI stills or narration are generated only for an approved draft and against a per-item budget. No video-generation subscription is assumed.

Verified growth reporting will retain platform snapshots for followers, reach, Reel/video views, engagements, and published-content identifiers only after official read permissions and exact asset identity are confirmed. TikTok remains a future Content Posting API integration (an unaudited client is private-only); YouTube Shorts remains a future OAuth `youtube.upload` integration. Neither is represented as available today.

Cloud scheduling is not complete in Preview: the protected tick endpoint and PostgreSQL leases are cloud-safe, but the current poller is the owner's persistent Windows worker. Vercel Cron targets the production deployment, so enabling it would cross the explicit Production boundary. The two honest next choices are a later owner-authorized Production Vercel Cron or a small always-on/scheduled cloud worker with an approved recurring cost. Until then, the dashboard must show `cloudScheduler: false` and cannot claim laptop-independent publication.
