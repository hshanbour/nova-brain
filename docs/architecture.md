# Nova Brain architecture

## Canonical MVP boundaries

```
HTTP / Vercel function
        |
        v
API adapter + validation + error mapping
        |
        v
Agent orchestrator ---- Tool registry ---- future actions/integrations
        |                       |
        v                       v
Model-provider interface    Memory-store interface
        |
        v
Mock provider today; real provider later
```

### API/server layer

`api/index.js` is the Vercel entry point. It constructs the application once per function instance and delegates every request to `src/http/api.js`. `src/local-server.js` is only a local adapter; production never calls `app.listen()`.

### Agent/orchestration layer

`src/agent/agent.js` owns the request-to-response flow. It loads conversation history, asks the model-provider interface for a response, stores the turn, and returns a stable agent response shape. It does not know HTTP or vendor details.

### AI/model-provider layer

`src/providers/mock-model-provider.js` provides the development-safe default. A future provider implements `generate({ message, conversationHistory, context })` and is injected through `createApp`; the agent does not need to change.

### Tools/actions layer

`src/tools/tool-registry.js` defines a small registry with explicit names, descriptions, and async `execute(input, context)` functions. The MVP deliberately registers no external tools. Future Sharp Cuts, marketing, research, website, outreach, and business-data actions belong here or in an integration adapter.

### Persistent data/memory layer

`src/memory/in-memory-store.js` implements the memory-store interface for tests and local development. It is ephemeral in a serverless environment and must not be treated as durable. A real database-backed adapter can replace it without changing the agent.

### Integrations layer

No integrations are configured today. Future adapters should own credentials, vendor payloads, retries, idempotency, and webhook verification. The agent should call their tools, not vendor SDKs directly.

### Configuration/environment handling

`src/config/env.js` centralizes supported environment variables and rejects unsupported model-provider selections. `.env.example` documents safe local defaults. Secrets belong in Vercel Project Settings or a local ignored env file.

### Validation and security

`src/http/validation.js` validates all JSON inputs. `src/http/api.js` limits JSON bodies, emits safe JSON errors, uses defensive response headers, and only enables CORS for configured origins. Authentication and authorization are intentionally not included until a concrete user/UI boundary is selected.

### Future telephony and SMS

A future telephony webhook should enter through a dedicated API route, verify the provider signature before parsing business data, translate the vendor event into a canonical missed-call event, and invoke an explicit tool. SMS sending requires an idempotency key, opt-out handling, consent policy, and audit trail before it is enabled.

### Future web/UI

A UI can call `POST /api/agent` or use a dedicated BFF route. It must authenticate users before durable personal/business data is exposed. Streaming can be added at the API boundary without coupling UI code to the agent core.
