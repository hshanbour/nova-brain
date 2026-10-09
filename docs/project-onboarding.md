# Owner-controlled project onboarding

Nova Console can create a durable project and stage owner-supplied knowledge for review. A staged fact is a `pending` memory candidate with an exact project ID, source record, content hash, provenance, and `authoritative: false`. It becomes active memory only after the owner accepts it in Owner & Memory. Corrections must identify the active same-project memory they supersede; the old record remains in history.

Supported source records are owner statements, document excerpts, public HTTPS references, and future GitHub, Vercel, Neon, or Stripe connection proposals. Source registration never fetches a URL and never grants provider access. Revocation disables the source authorization but does not rewrite already reviewed memory history.

Future provider connections are deliberately proposals only:

- GitHub: one repository through a fine-grained token or GitHub App installation.
- Vercel: one project/team-scoped read surface or a narrow projection endpoint.
- Neon: a project-specific read-only database role or projection.
- Stripe: a restricted key limited to the exact required read resources.

Every initial connection and later permission escalation requires a separate formal owner approval. Account-wide unrestricted credentials are forbidden. Provider secrets never belong in project source records, memory, Activity, or browser responses.

## Model allowance

The Console budget card reads Nova's internal model-cost ledger. `NOVA_OPENAI_GLOBAL_BUDGET_USD` is the configured safety allowance; `NOVA_OPENAI_BUDGET_ID` selects its durable PostgreSQL ledger and `NOVA_OPENAI_TASK_BUDGET_USD` adds a per-task cap. Reservations are made before a provider call and settled from reported token usage plus configured fixed search costs. The ledger is an application circuit breaker, not prepaid OpenAI credit and not an invoice reconciliation system. When insufficient allowance remains, Nova blocks the provider call before invocation with `cost_budget_exhausted`.

Increasing OpenAI account credit changes provider billing capacity; increasing Nova's allowance changes only Nova's local authorization ceiling. This release intentionally exposes read-only status in Console. Any future adjustment control should create an immutable proposal, show current/new caps and remaining provider credit separately, require formal owner approval, and remain capped by a separately configured maximum; it must not silently edit provider billing.
