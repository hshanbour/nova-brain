# Nova Brain architecture

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
Model-provider interface    Memory-store interface
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

### Persistent data/memory layer

`src/memory/in-memory-store.js` implements the memory-store interface for tests and local development. It is ephemeral in a serverless environment and must not be treated as durable. A real database-backed adapter can replace it without changing the agent.

### Integrations layer

No integrations are configured today. Future adapters should own credentials, vendor payloads, retries, idempotency, and webhook verification. The agent should call their tools, not vendor SDKs directly.

### Configuration/environment handling

`src/config/env.js` centralizes provider selection, OpenAI configuration, and bounded execution limits. Selecting `openai` requires `OPENAI_API_KEY` and `OPENAI_MODEL`; selecting `mock` requires no credentials. `.env.example` contains names and safe defaults only. Secrets belong in Vercel Project Settings or a local ignored env file.

### Validation and security

`src/http/validation.js` validates all JSON inputs. `src/http/api.js` limits JSON bodies, emits safe JSON errors, uses defensive response headers, and only enables CORS for configured origins. Authentication and authorization are intentionally not included until a concrete user/UI boundary is selected.

### Future telephony and SMS

A future telephony webhook should enter through a dedicated API route, verify the provider signature before parsing business data, translate the vendor event into a canonical missed-call event, and invoke an explicit tool. SMS sending requires an idempotency key, opt-out handling, consent policy, and audit trail before it is enabled.

### Future web/UI

A UI can call `POST /api/agent` or use a dedicated BFF route. It must authenticate users before durable personal/business data is exposed. Streaming can be added at the API boundary without coupling UI code to the agent core.

## Current limitations

- Memory remains process-local and ephemeral on Vercel.
- No authentication or authorization is implemented.
- No external tools or business integrations are registered.
- OpenAI is the only production provider adapter.
- Tool calls are sequential, even if a provider can generate parallel calls.
- There is no streaming, retry policy, usage accounting, or durable execution trace yet.
