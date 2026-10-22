# Sharp Cuts media automation

## Enforced data flow

1. Owner-selected originals are copied into a dedicated local Sharp Cuts workspace with a random 192-bit capability ID and SHA-256 digest.
2. Nova stores only metadata and the opaque capability ID in Preview. Raw bytes, working files, drafts, and rejected renders stay on Windows.
3. The Windows worker claims a fenced render job and invokes FFmpeg with an argument array (never a shell command). The output is registered as a local rendered asset.
4. The owner reviews the local final. A formal `social_media_promote` approval binds the project, content hash, asset ID, SHA-256, and byte count.
5. Only the approved promotion job may upload that exact binary to the private Sharp Cuts R2 prefix. A later content revision makes the queued job stale before upload.
6. Nova verifies the uploaded byte count and SHA-256 before recording the private R2 object key. No permanent public object URL is stored.
7. Publishing remains a separate formal approval. At execution time the cloud worker must generate a short-lived media delivery URL; failure to do so stops the publication safely.

## Preview-only configuration contract

The Windows worker reads `NOVA_SHARP_CUTS_MEDIA_ROOT` locally and may use `NOVA_FFMPEG_EXECUTABLE` to bind a reviewed FFmpeg binary. Neither value grants cloud access, and the media root is never returned by the dashboard.

When the media root is configured, the persistent worker starts a review companion on `127.0.0.1:43127`. It serves only completed renders, supports byte-range playback, exposes no original-footage route, has no CORS grant, and never binds a LAN or public interface. The Nova dashboard links to this local review surface without receiving the opaque local capability IDs.

Private R2 support is disabled unless all four server-only Preview variables are present: `NOVA_SHARP_CUTS_R2_ACCOUNT_ID`, `NOVA_SHARP_CUTS_R2_BUCKET`, `NOVA_SHARP_CUTS_R2_ACCESS_KEY_ID`, and `NOVA_SHARP_CUTS_R2_SECRET_ACCESS_KEY`. `NOVA_SHARP_CUTS_R2_HARD_QUOTA_BYTES` defaults to 8 GiB and cannot exceed 10 GiB. The credential must be restricted in Cloudflare to the one approved-media bucket; Nova additionally restricts object keys to `sharp-cuts-web/approved/<sha256>.<extension>`.

Signed upload and review URLs expire after 15 minutes. They are created only server-side, and an upload URL is returned only through the existing authenticated local-worker endpoint. The Social Command Centre receives policy/status metadata, never R2 credentials or presigned upload URLs.

`NOVA_SOCIAL_SCHEDULER_TOKEN` is a separate 32-byte-or-longer secret for a future cloud scheduler calling `/api/admin/scheduler/social/tick`. It cannot equal the Windows Worker token. The endpoint processes only already-scheduled, immutable, owner-approved publications, and the existing `NOVA_SOCIAL_LIVE_ENABLED=false` gate still makes it a no-op. Creating or activating the external scheduler remains a separate approval boundary.

## Prepared migration 30

Migration 30 is additive. It creates project-scoped asset metadata, durable media jobs, and marketing-calendar entries. It does not alter or copy existing social content, Meta connections, memories, or business data. Recovery is to stop the new media worker and remove only the three new empty/isolated tables after preserving any required audit metadata; this has not been applied.

## Activation boundaries

The following remain deliberately inactive until owner approval:

- install FFmpeg on Windows and bind its exact executable to the local worker;
- apply migration 30 to the verified Nova Preview PostgreSQL database;
- create one private R2 bucket and one bucket-scoped Object Read/Write credential for the Sharp Cuts approved-media prefix;
- add branch-scoped Preview secrets and an application hard quota below the R2 free allowance;
- deploy and verify Preview;
- configure a cloud scheduler/publisher. Live publishing remains disabled after this step.

No CapCut API is used. CapCut Free remains an optional owner-operated finishing step whose exported MP4 re-enters the same local hash and approval flow.
