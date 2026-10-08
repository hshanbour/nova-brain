# Nova Brain

Nova Brain is an extensible personal AI operating system. Nova Console is its owner-facing interface; the backend agent remains independent so future web, mobile, voice, messaging, and business channels can connect to the same brain.

## Current MVP

The repository provides a small, serverless-compatible agent runtime:

- `GET /` serves Nova Console V1, a responsive interface connected to the live agent API.
- `GET /api/health` returns a machine-readable health response.
- `POST /api/agent` accepts a validated agent request and runs a bounded model/tool loop.
- Premium Start Voice records bounded microphone turns with `MediaRecorder`, transcribes through server-side OpenAI GPT-Transcribe, reuses `POST /api/agent`, and plays the owner-selected ElevenLabs voice.
- `POST /api/missed-call` preserves the original scaffold endpoint as a validated intake placeholder.
- The agent, model providers, tools, durable storage, configuration, and HTTP adapter are separate modules.
- The Memory workspace exposes controlled owner-profile editing and explicit long-term-memory create, edit, filter, and forget operations.
- Conversation messages and long-term memory are separate data types; only a bounded relevant memory subset enters each model request.
- Nova Email V1 can connect the single approved Gmail mailbox through server-side OAuth, search/read mail, prepare internal drafts, and send only an immutable owner-approved draft.

The mock provider remains the credential-free default. An OpenAI Responses API provider is available when explicitly configured. PostgreSQL (including Neon) is supported for durable private state, with in-memory storage retained for tests and local fallback. Gmail is the only owner-mail integration; no telephony, SMS, Gmail mutation/settings capability, or application-level authentication is connected.

## Run locally

Requires Node.js 24.

```bash
npm install
npm run dev
npm test
```

Set local values in your shell or load them from an ignored environment file with your process manager. Never commit a real `.env` file.

## API

### Nova Console

```http
GET /
```

Vercel serves `index.html` and the dependency-free files under `assets/`. The local Node adapter serves the same allowlisted static files. The console passes the returned `conversationId` into later messages until the owner starts a new conversation, and shows safe provider, step, and tool-execution metadata.

The console includes a minimal web app manifest and mobile standalone metadata. It does not implement offline caching yet.

### Security

The current Preview remains protected by Vercel Authentication. Nova Console contains no API keys or environment-variable values; it calls same-origin backend routes only. Application-level owner authentication and authorization are still required before any public or production exposure. Do not treat Preview protection as the final product access-control layer.

Private profile and memory responses use `Cache-Control: no-store`. Database and provider failures return safe errors without connection strings, keys, vendor response bodies, or stack traces. Owner facts are seeded only from the explicitly approved source in `src/identity/initial-context.js`; model output is never promoted to long-term memory automatically.

### Health

```http
GET /api/health
```

The response includes the selected storage provider, durability flag, and `ready` or `degraded` status. It never includes a database URL.

### Private owner data APIs

```http
GET   /api/owner/profile
PATCH /api/owner/profile
GET   /api/memories
POST  /api/memories
PATCH /api/memories/:id
DELETE /api/memories/:id
GET   /api/conversations
GET   /api/conversations/:id/messages
```

Memory records have an explicit category, provenance, privacy, sensitivity, and global/system/project scope. `DELETE` is a soft delete (“forget”) so inactive records cannot be retrieved by Nova. The API accepts only allowlisted fields and categories. Evidence extracted from typed owner turns or canonical terminal task outcomes is stored separately as a pending learning candidate. It remains non-authoritative and unavailable to retrieval until the owner accepts it in the Memory workspace; candidates can also be rejected or used to supersede an active same-scope memory, with every decision recorded in Activity. Explicit corrections preserve the superseded record rather than overwriting history. Project-bound durable research captures a small provenance-aware snapshot of accepted memory and reviewed lessons at task creation so the persistent worker can use the same verified context after interruption without searching another project or exposing private memory to public Web collection. Final research synthesis persists a bounded claim manifest and fails closed when important business or quantitative assertions are not bound to retained public evidence or accepted project memory.

### Agent request

```http
POST /api/agent
Content-Type: application/json

{
  "message": "Help me plan this week's Sharp Cuts marketing."
}
```

The default `mock` provider makes this endpoint usable without credentials. Its response is deliberately deterministic, not AI-generated.

The response preserves the existing `message`, `conversationId`, `provider`, and `toolCalls` fields and adds `steps`, the number of model steps used. `toolCalls` contains only normalized execution metadata; raw provider responses and credentials are never returned.

### Nova Voice V2

```http
GET  /api/voice/readiness
POST /api/voice/transcribe
POST /api/voice/speech
```

Start Voice is a continuous browser channel for the existing Nova agent—not a separate voice agent. It uses `getUserMedia`, `MediaRecorder`, and bounded silence detection; no browser `SpeechRecognition` locale is imposed on the premium path. Recorded bytes are sent only to the same-origin transcription endpoint and are not persisted. The transcript enters the exact typed-chat submission function, so durable conversations, memory retrieval, projects, tools, approvals, and activity behave identically.

The speech endpoint accepts only Nova's owner-facing assistant message, sanitises it, enforces a character limit, and splits longer replies at bounded sentence/phrase boundaries. It streams ordered, complete MP3 chunks with `no-store`, allowing the browser to play the first phrase while later phrases are generated and prefetched. Voice readiness verifies the configured ElevenLabs key, owner-selected voice access, and an account-supported text-to-speech model through ElevenLabs' model and voice metadata APIs before Voice Mode starts. Nova prefers `eleven_v3_conversational`, visibly reports any supported fallback selection, and uses `mp3_44100_128`. Because the live REST service rejects request-stitching context with the conversational v3 path, Nova does not send `previous_text` or `next_text` for that model; semantic chunk order is maintained by Nova's own stream protocol. `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID` remain server-only. Browser-native recognition and speech controls remain available as explicitly labelled legacy utilities and are never used as a silent fallback when Voice V2 fails.

### Missed-call intake placeholder

```http
POST /api/missed-call
Content-Type: application/json

{
  "name": "A customer",
  "phone": "+441234567890"
}
```

This endpoint does not send messages, create leads, or contact external services.

### Nova Email V1

```http
POST /api/integrations/gmail/oauth/start
GET  /api/integrations/gmail/oauth/callback
GET  /api/integrations/gmail/status
POST /api/integrations/gmail/disconnect
```

Gmail OAuth is optional and fails closed unless all five server-only variables below are present. The expected account is exactly `novadigitalservicesuk@gmail.com`. The registered Preview callback is `https://nova-test-project-git-codex-combine-ede5f3-hamodehshanbour-6196.vercel.app/api/integrations/gmail/oauth/callback`.

```env
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
NOVA_GMAIL_OAUTH_REDIRECT_URI=
NOVA_GMAIL_TOKEN_ENCRYPTION_KEY=
NOVA_GMAIL_ACCOUNT_EMAIL=
```

`NOVA_GMAIL_TOKEN_ENCRYPTION_KEY` must be a cryptographically random 32-byte value encoded as Base64 (or 64 hexadecimal characters). Never expose these variables to browser code. OAuth state is single-use, expires after ten minutes, is bound to an HttpOnly same-site callback cookie, and stores only hashes plus an encrypted PKCE verifier. Access and refresh tokens are encrypted at rest with AES-256-GCM and are never returned by the API.

The model-visible tools are `gmail_search`, `gmail_thread_read`, `gmail_draft_prepare`, and `gmail_send`. Search and thread reads are `READ_ONLY`; draft preparation only writes Nova's internal PostgreSQL draft. `gmail_send` is `SENSITIVE` and uses Nova's existing approval and Activity systems. The approval arguments contain the exact To, CC, BCC, Subject, and Body and are cryptographically bound to the stored draft. A durable send-intent ledger prevents automatic retries after an in-progress or ambiguous provider outcome. Nova does not use the Gmail Draft, delete, modify/label, or settings APIs.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the canonical MVP boundaries and extension points.

## Model providers

### Mock provider

The default configuration needs no credentials:

```env
NOVA_BRAIN_MODEL_PROVIDER=mock
```

### OpenAI provider

The OpenAI adapter uses the Responses API and translates its function calls into Nova Brain's provider-independent tool contract. Configure it only through environment variables:

```env
NOVA_BRAIN_MODEL_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=
```

Set the actual values locally in an ignored environment file or in Vercel Project Settings. Never commit an API key. Startup fails clearly if either required OpenAI value is missing. Automated tests use a fake HTTP transport and never make paid API calls. See the [official OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).

Nova pins Responses requests to the standard `default` service tier unless `NOVA_BRAIN_OPENAI_SERVICE_TIER=flex` is explicitly configured; premium/fast tiers are rejected. Chat and no-change verification default to `gpt-6-luna` with `none` reasoning, while canonical planning remains on `OPENAI_MODEL`. Optional `NOVA_BRAIN_CHAT_*`, `NOVA_BRAIN_PLANNER_*`, and `NOVA_BRAIN_NO_CHANGE_*` variables can independently override the model, reasoning effort, and maximum output tokens; there is no automatic model-escalation loop. Successful calls record bounded model, stage, service-tier, input, cached-input, output, reasoning, and total token counts in durable run or planner-step results; prompts and provider response bodies are not recorded as usage telemetry.

## Bounded agent loop

Each request can take at most `NOVA_BRAIN_MAX_STEPS` model steps (default `5`, allowed `1-10`). A model step may return a final answer or request registered tools. Tool requests are executed only by name through the registry, and their structured results are returned to the provider for the next step. At most `NOVA_BRAIN_MAX_TOOL_CALLS_PER_STEP` tools may be requested in one step (default `4`, allowed `1-10`).

Unknown tools, invalid arguments, and tool failures are contained and returned to the model as failed tool results. The runtime never executes arbitrary code, shell commands, URLs, or unregistered actions. Reaching a limit ends the request with a safe `502` error.

Nova now registers bounded repository inspection tools, durable project listing, and an approval-gated memory-forget action. Local development can also run the allowlisted Node test suite. Repository writes require server-only GitHub configuration and are restricted to `NOVA_BRAIN_DEVELOPMENT_BRANCH`; arbitrary shell execution is never exposed. Vercel inspection tools remain visibly unavailable until their adapter is implemented and configured.

Nova Web keeps `web_research` as its only model-visible web tool. Optional rendered-page escalation uses a server-owned, durable `web_<id>` task and a fresh Cloudflare Browser Rendering session connected through Playwright CDP; the Persistent Local Worker only coordinates the protected server route and receives neither browser credentials nor a local browser. Configure `NOVA_BRAIN_CLOUDFLARE_ACCOUNT_ID` and `NOVA_BRAIN_CLOUDFLARE_BROWSER_TOKEN` only when activating this adapter. The token needs Cloudflare's Browser Rendering Write permission for the selected account. The separate provider ledger defaults to a $0.50 global ceiling with $0.01 normal and $0.02 explicit-heavy reservations. No browser session is created unless both that reservation and the existing model-budget reservation succeed.

## Durable storage and migrations

Storage selection defaults to `auto`: Nova uses PostgreSQL when one of `DATABASE_URL`, `POSTGRES_URL`, or `POSTGRES_URL_NON_POOLING` exists, otherwise it uses process-local memory. To require a specific adapter, set `NOVA_BRAIN_STORAGE_PROVIDER=postgres` or `memory`. Explicit `postgres` configuration fails closed if no connection string is present.

Schema initialization and approved seed data are idempotent and run before storage-backed requests. Nova Email V1 adds the reproducible `migrations/004_gmail_v1.sql` schema for OAuth state, encrypted connections, internal drafts, and send intents. For an explicit migration check, run this with a server-side database URL in your shell:

```bash
npm run db:migrate
```

The reproducible SQL is in `migrations/001_owner_memory_foundation.sql`. Never expose database variables to browser code or prefix them with `NEXT_PUBLIC_`/`VITE_`. The in-memory adapter is intentionally non-durable and should not be used for a deployed personal system.

Conversation history is bounded by `NOVA_BRAIN_HISTORY_LIMIT` (default `24`). Relevant long-term-memory retrieval is bounded by `NOVA_BRAIN_MEMORY_LIMIT` (default `6`). Private owner identity is always minimal; family details are included only for directly relevant requests.

## Deployment

Vercel serves the root `index.html` as a static asset and automatically treats `api/index.js` as a Node.js serverless function for API requests. `vercel.json` rewrites requests without a matching static asset to that function. Configure environment variables in Vercel Project Settings; do not add secrets to the repository. Preview deployments must remain behind Vercel Authentication until robust owner authorization exists in the application.
