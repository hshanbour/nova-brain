# Nova developer-session adapter spike

The adapter boundary is deliberately outside the existing self-development runtime. Nova remains authoritative for task identity, intent, repository and branch identity, base commit, acceptance criteria, path scope, approvals, audit records, product decisions, and final acceptance. A selected developer provider receives only a frozen execution contract and may own repository inspection, file operations, shell/test execution, and mechanical iteration within that contract.

`createDeveloperSessionAdapter` exposes `startDeveloperSession`, `resumeDeveloperSession`, `getDeveloperSession`, and `cancelDeveloperSession`. It requires an injected persistent session store, records both Nova's adapter session ID and the provider session ID, refuses provider session replacement, normalizes approval-required states, requires structured completion results, and checks every reported changed path against Nova's policy. Dry-run sessions reject every product mutation.

`createDeveloperProviderRouter` defaults to `legacy`; selecting `agents_api` is explicit. The legacy provider is an adapter over the current Developer Runtime and is not removed or disabled. The managed provider uses the official Agents session endpoints, but live use requires `OPENAI_API_KEY`, `NOVA_DEVELOPER_AGENT_ID`, and an explicitly provisioned managed repository environment. The spike does not set those values, switch runtime routing, or execute a managed session.

Push and deployment are false unless Nova explicitly enables each capability. Provider errors become bounded failures and upstream error text is not persisted. The microphone fixture is dry-run only and carries the exact eight-file scope and acceptance criteria without connecting to or mutating the real v451 task.
