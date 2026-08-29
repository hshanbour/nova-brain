# Nova Brain

Nova Brain is an extensible personal AI operating system. Nova Console is its owner-facing interface; the backend agent remains independent so future web, mobile, voice, messaging, and business channels can connect to the same brain.

## Current MVP

The repository provides a small, serverless-compatible agent runtime:

- `GET /` serves Nova Console V1, a responsive interface connected to the live agent API.
- `GET /api/health` returns a machine-readable health response.
- `POST /api/agent` accepts a validated agent request and runs a bounded model/tool loop.
- `POST /api/missed-call` preserves the original scaffold endpoint as a validated intake placeholder.
- The agent, model providers, tools, durable storage, configuration, and HTTP adapter are separate modules.
- The Memory workspace exposes controlled owner-profile editing and explicit long-term-memory create, edit, filter, and forget operations.
- Conversation messages and long-term memory are separate data types; only a bounded relevant memory subset enters each model request.

The mock provider remains the credential-free default. An OpenAI Responses API provider is available when explicitly configured. PostgreSQL (including Neon) is supported for durable private state, with in-memory storage retained for tests and local fallback. No telephony, SMS, business integration, application-level authentication, or external tool is connected yet.

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

Memory records have an explicit category, provenance, privacy, sensitivity, and global/system/project scope. `DELETE` is a soft delete (“forget”) so inactive records cannot be retrieved by Nova. The API accepts only allowlisted fields and categories.

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

## Bounded agent loop

Each request can take at most `NOVA_BRAIN_MAX_STEPS` model steps (default `5`, allowed `1-10`). A model step may return a final answer or request registered tools. Tool requests are executed only by name through the registry, and their structured results are returned to the provider for the next step. At most `NOVA_BRAIN_MAX_TOOL_CALLS_PER_STEP` tools may be requested in one step (default `4`, allowed `1-10`).

Unknown tools, invalid arguments, and tool failures are contained and returned to the model as failed tool results. The runtime never executes arbitrary code, shell commands, URLs, or unregistered actions. Reaching a limit ends the request with a safe `502` error.

No external tools are registered yet, so configuring OpenAI currently enables real model responses but no business actions.

## Durable storage and migrations

Storage selection defaults to `auto`: Nova uses PostgreSQL when one of `DATABASE_URL`, `POSTGRES_URL`, or `POSTGRES_URL_NON_POOLING` exists, otherwise it uses process-local memory. To require a specific adapter, set `NOVA_BRAIN_STORAGE_PROVIDER=postgres` or `memory`. Explicit `postgres` configuration fails closed if no connection string is present.

Schema initialization and approved seed data are idempotent and run before storage-backed requests. For an explicit migration check, run this with a server-side database URL in your shell:

```bash
npm run db:migrate
```

The reproducible SQL is in `migrations/001_owner_memory_foundation.sql`. Never expose database variables to browser code or prefix them with `NEXT_PUBLIC_`/`VITE_`. The in-memory adapter is intentionally non-durable and should not be used for a deployed personal system.

Conversation history is bounded by `NOVA_BRAIN_HISTORY_LIMIT` (default `24`). Relevant long-term-memory retrieval is bounded by `NOVA_BRAIN_MEMORY_LIMIT` (default `6`). Private owner identity is always minimal; family details are included only for directly relevant requests.

## Deployment

Vercel serves the root `index.html` as a static asset and automatically treats `api/index.js` as a Node.js serverless function for API requests. `vercel.json` rewrites requests without a matching static asset to that function. Configure environment variables in Vercel Project Settings; do not add secrets to the repository. Preview deployments must remain behind Vercel Authentication until robust owner authorization exists in the application.
