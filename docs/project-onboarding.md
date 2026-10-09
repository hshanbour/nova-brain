# Owner-controlled project onboarding

Nova Console can create a durable project, upload a PDF/DOCX/TXT/Markdown document, ingest one explicitly submitted public HTTPS page, and stage extracted knowledge for review. A staged statement is a `pending` memory candidate with an exact project ID, source record, content hash, evidence excerpt, provenance, and `authoritative: false`. It becomes project memory only after the owner accepts it in Projects or Owner & Memory. Corrections must identify the active same-project memory they supersede; the old record remains in history.

Document uploads are capped at 4 MB; PDFs at 40 pages; retained extracted text at 100,000 characters. Extraction runs in memory, rejects extension/MIME/signature mismatches, macros and embedded DOCX objects, invalid UTF-8, corrupt files, and credential-shaped content. Raw uploaded bytes are discarded. Only bounded extracted text, hashes, source metadata, and review evidence are durable.

Public URL ingestion reuses Nova's credential-free public page reader. It permits only HTTPS on standard ports, resolves and validates every host and redirect, rejects private/reserved/metadata addresses and DNS rebinding, respects robots.txt, and applies timeout, redirect, content-type, and response-size limits. It does not bypass authentication, CAPTCHA, paywalls, or access restrictions and does not crawl the domain. Retrieved page text is marked untrusted; instruction-shaped page content is excluded from candidates and cannot change Nova's authority.

Supported source records are owner statements, extracted owner documents, retained public pages, and future GitHub, Vercel, Neon, or Stripe connection proposals. Connector source registration never grants provider access. Revocation disables the source authorization but does not rewrite already reviewed memory history. A changed document or page creates a new content-hash version rather than silently overwriting earlier evidence.

Future provider connections are deliberately proposals only:

- GitHub: one repository through a fine-grained token or GitHub App installation.
- Vercel: one project/team-scoped read surface or a narrow projection endpoint.
- Neon: a project-specific read-only database role or projection.
- Stripe: a restricted key limited to the exact required read resources.

Every initial connection and later permission escalation requires a separate formal owner approval. Account-wide unrestricted credentials are forbidden. Provider secrets never belong in project source records, memory, Activity, or browser responses.

## Model allowance

The Console budget card reads Nova's internal model-cost ledger. `NOVA_OPENAI_GLOBAL_BUDGET_USD` is the configured safety allowance; `NOVA_OPENAI_BUDGET_ID` selects its durable PostgreSQL ledger and `NOVA_OPENAI_TASK_BUDGET_USD` adds a per-task cap. Reservations are made before a provider call and settled from reported token usage plus configured fixed search costs. The ledger is an application circuit breaker, not prepaid OpenAI credit and not an invoice reconciliation system. When insufficient allowance remains, Nova blocks the provider call before invocation with `cost_budget_exhausted`.

Increasing OpenAI account credit changes provider billing capacity; increasing Nova's allowance changes only Nova's local authorization ceiling. This release intentionally exposes read-only status in Console. Any future adjustment control should create an immutable proposal, show current/new caps and remaining provider credit separately, require formal owner approval, and remain capped by a separately configured maximum; it must not silently edit provider billing.
