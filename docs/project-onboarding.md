# Owner-controlled project onboarding

Nova Console can create a durable project, upload a PDF/DOCX/TXT/Markdown document, ingest one explicitly submitted public HTTPS page, and stage extracted knowledge for review. A staged statement is a `pending` memory candidate with an exact project ID, source record, content hash, evidence excerpt, provenance, and `authoritative: false`. It becomes project memory only after the owner accepts it in Projects or Owner & Memory. Corrections must identify the active same-project memory they supersede; the old record remains in history.

Document uploads are capped at 4 MB; PDFs at 40 pages; retained extracted text at 100,000 characters. Extraction runs in memory, rejects extension/MIME/signature mismatches, macros and embedded DOCX objects, invalid UTF-8, corrupt files, and credential-shaped content. Raw uploaded bytes are discarded. Only bounded extracted text, hashes, source metadata, and review evidence are durable.

Public URL ingestion reuses Nova's credential-free public page reader. It permits only HTTPS on standard ports, resolves and validates every host and redirect, rejects private/reserved/metadata addresses and DNS rebinding, respects robots.txt, and applies timeout, redirect, content-type, and response-size limits. It does not bypass authentication, CAPTCHA, paywalls, or access restrictions and does not crawl the domain. Retrieved page text is marked untrusted; instruction-shaped page content is excluded from candidates and cannot change Nova's authority.

Supported source records are owner statements, extracted owner documents, retained public pages, and GitHub, Vercel, Neon, or Stripe connection proposals. Connector source registration never grants provider access. Revocation disables the source authorization but does not rewrite already reviewed memory history. A changed document or page creates a new content-hash version rather than silently overwriting earlier evidence.

## Provider discovery boundaries

For this private owner-operated Nova instance, Vercel account discovery uses a dedicated Vercel access token scoped to the owner's team and All Projects. Vercel access tokens are resource-scoped rather than HTTP-method-scoped, so Nova does not describe the provider credential itself as read-only. The server enforces a deterministic allowlist containing only `GET /v9/projects`, `GET /v9/projects/:id`, and `GET /v6/deployments`; redirects, other hosts, additional paths, query parameters, and every non-GET method fail closed. The discovery token is configured separately from Nova's deployment credential and is never reusable by execution tools. Selecting All Projects allows later projects to appear on the next bounded refresh without a code change. The token remains a server-only Preview secret and is never returned to the browser.

GitHub and Neon remain independent connections. A Vercel installation neither supplies nor implies repository or database access. Each provider reports `connected`, `not configured`, `expired`, or insufficient-permission state independently.

Discovery is read-only and distinct from knowledge ingestion and execution. Inspection may create a proposed fact set, but only the existing owner-review flow can import it into project memory. No provider connection grants execution authority. A later change must name the stable Nova project, exact external resources, action, consequences, and rollback plan, and must receive a formal owner approval before a narrowly scoped adapter can execute it.

Every initial connection and later permission escalation requires owner authorization. Provider secrets never belong in project source records, memory, Activity, or browser responses. Token rotation or revocation is performed from the owner's Vercel Account Tokens page and does not erase previously accepted, provenance-preserving project history.

## Model allowance

The Console budget card reads Nova's internal model-cost ledger. `NOVA_OPENAI_GLOBAL_BUDGET_USD` is the configured safety allowance; `NOVA_OPENAI_BUDGET_ID` selects its durable PostgreSQL ledger and `NOVA_OPENAI_TASK_BUDGET_USD` adds a per-task cap. Reservations are made before a provider call and settled from reported token usage plus configured fixed search costs. The ledger is an application circuit breaker, not prepaid OpenAI credit and not an invoice reconciliation system. When insufficient allowance remains, Nova blocks the provider call before invocation with `cost_budget_exhausted`.

Increasing OpenAI account credit changes provider billing capacity; increasing Nova's allowance changes only Nova's local authorization ceiling. This release intentionally exposes read-only status in Console. Any future adjustment control should create an immutable proposal, show current/new caps and remaining provider credit separately, require formal owner approval, and remain capped by a separately configured maximum; it must not silently edit provider billing.
