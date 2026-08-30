# Nova Brain architecture

## Nova Console

`index.html` and `assets/` form a dependency-free presentation layer. `assets/api-client.js` owns the browser-to-agent contract and conversation continuity; it does not contain agent logic. The browser calls same-origin `/api/health` and `/api/agent` routes, while all provider credentials and model execution remain server-side.

The console exposes Chat and Memory. Memory provides controlled profile editing and explicit long-term-memory CRUD; Projects, Activity, Tools, and Approvals remain inactive product boundaries. The manifest provides a PWA-ready shell without a service worker or offline behavior.

## Canonical MVP boundaries

```
HTTP / Vercel function
        |
        v
API adapter + validation + error mapping
        |
        v
Bounded agent loop ----- Tool registry ---- future actions/integrations
        |                       |
        v                       v
Model-provider interface    Storage interface
                                  |
                         memory or PostgreSQL
        |
        v
Mock or OpenAI provider
```

### API/server layer

`index.html` is the landing page at `GET /`. Vercel serves it directly, while `src/local-server.js` serves the same file during local development. `GET /api/health` is the machine-readable health endpoint. `api/index.js` is the Vercel API entry point: it constructs the application once per function instance and delegates API requests to `src/http/api.js`. `src/local-server.js` is only a local adapter; production never calls `app.listen()`.

### Agent/orchestration layer

`src/agent/agent.js` owns the request-to-response flow. It loads conversation history and repeatedly asks the selected provider for either a final message or normalized tool calls. Requested tools execute through the registry, and normalized results feed the next model step. The loop has hard model-step and per-step tool-call limits. It stores the completed user/assistant turn and returns a stable response shape without knowing HTTP or vendor details.

### AI/model-provider layer

`src/providers/mock-model-provider.js` provides the deterministic development/test default. `src/providers/openai-model-provider.js` uses the OpenAI Responses API without an SDK dependency. It owns authentication, request translation, response parsing, function-call parsing, and opaque continuation tokens.

The provider-independent `generate` contract receives the user message, stored conversation history, untrusted context, tool definitions, prior tool results, and an optional opaque continuation token. It returns exactly one of:

- `{ type: "final", message }`
- `{ type: "tool_calls", toolCalls: [{ id, name, arguments }], continuationToken }`

OpenAI response objects, function-call output objects, and response IDs never enter the agent, tool registry, or memory contracts.

### Tools/actions layer

`src/tools/tool-registry.js` defines tools with explicit names, descriptions, optional JSON input schemas, optional validation functions, and async `execute(input, context)` functions. Only registered names can execute. Invalid, unknown, and failed calls become safe failed tool results rather than arbitrary execution or process crashes. The milestone deliberately registers no external tools.

### Owner identity, conversation, and memory

`src/identity/initial-context.js` is the reviewed seed source for Mohammad Shanbour (`محمد شنبور`), his preferences, active projects, and Nova's product purpose. Deterministic IDs plus conflict-safe inserts make initialization repeatable without overwriting owner edits. No GitHub username, model inference, or chat content becomes identity truth.

The provider-neutral interface in `src/storage/` has in-memory and PostgreSQL adapters. Its schema separates owner profile, projects, conversations, messages, and categorized long-term memories. PostgreSQL is durable; memory is a non-durable local/test fallback. `migrations/001_owner_memory_foundation.sql` is the canonical schema migration.

The agent loads only bounded recent messages and calls `src/memory/context-retriever.js` for a small relevance-ranked memory subset. Core profile fields are minimized, especially family data. System communication policy is global: British English by default, adaptive Arabic when useful, recipient-aware tone, and no disclosure of private context unless the owner asks for it and the task requires it. Conversation content is never automatically promoted into long-term memory.

Relevant retrieved context is sent server-side to the configured model provider when inference requires it. This is an explicit trust boundary: private data is minimized before the request, but it can leave Nova's application server for the configured provider. External tools receive no profile or memory database by default and future actions must pass only task-authorized minimum fields.

Retrieval currently uses explainable token overlap plus small project/core-memory boosts over a bounded candidate set. A future semantic adapter can add embeddings or hybrid search behind the same storage/retrieval contract without changing agent orchestration or canonical records.

### Integrations layer

No integrations are configured today. Future adapters should own credentials, vendor payloads, retries, idempotency, and webhook verification. The agent should call their tools, not vendor SDKs directly.

### Configuration/environment handling

`src/config/env.js` centralizes model/storage selection and bounded execution limits. Storage auto-detects standard server-side PostgreSQL variables and never serializes them into HTTP responses. Selecting `openai` requires `OPENAI_API_KEY` and `OPENAI_MODEL`; selecting `mock` requires no credentials. `.env.example` contains names and safe defaults only. Secrets belong in Vercel Project Settings or a local ignored env file.

### Voice Benchmark isolation

Nova Voice V2 Phase 0 lives under `src/benchmark/` and `/api/voice-benchmark/*`. It is an evaluation harness, not the production Voice V2 architecture. OpenAI, Deepgram, Azure, and ElevenLabs calls are made only by server-side adapters. Execution is denied unless `NOVA_VOICE_BENCHMARK_PAID_CALLS_APPROVED=true`, and all durable cost reservations for the owner count toward `NOVA_VOICE_BENCHMARK_BUDGET_USD`, which cannot exceed USD 2.00.

Benchmark sessions and result metadata use dedicated PostgreSQL tables. They are never inserted into Nova long-term memory. Owner microphone bytes exist only in the browser and request lifecycle; neither storage implementation accepts raw-audio fields. The initial comparison uses short batch requests, so measured latency is request start to complete transcript or complete playable audio—not realtime first-token latency.

### Validation and security

`src/http/validation.js` validates all JSON inputs and allowlists mutable profile/memory fields. `src/http/api.js` limits JSON bodies, disables caching of private responses, emits safe errors, uses defensive headers, and only enables CORS for configured origins. Storage failure is fail-closed for private endpoints. Vercel Authentication is the current Preview boundary; application-level authentication and owner authorization remain mandatory before public or Production exposure.

### Future telephony and SMS

A future telephony webhook should enter through a dedicated API route, verify the provider signature before parsing business data, translate the vendor event into a canonical missed-call event, and invoke an explicit tool. SMS sending requires an idempotency key, opt-out handling, consent policy, and audit trail before it is enabled.

### Future web/UI

A UI can call `POST /api/agent` or use a dedicated BFF route. It must authenticate users before durable personal/business data is exposed. Streaming can be added at the API boundary without coupling UI code to the agent core.

### Future channels

Web, native mobile, voice, phone, WhatsApp, SMS, and email adapters should authenticate/identify the owner or recipient, normalize channel events, and call the same agent/storage domains. They must not create channel-specific owner identities or memory silos. Each adapter owns its vendor credentials, consent, delivery metadata, and privacy-minimizing projection.

## Current limitations

- Durable state requires a configured PostgreSQL/Neon connection; otherwise health explicitly reports the non-durable memory adapter.
- No application-level authentication or authorization is implemented; Vercel Authentication protects Preview only.
- No external tools or business integrations are registered.
- OpenAI is the only production provider adapter.
- Tool calls are sequential, even if a provider can generate parallel calls.
- There is no streaming, retry policy, usage accounting, or durable execution trace yet.
