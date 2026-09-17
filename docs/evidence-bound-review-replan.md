# Private rejection evidence and evidence-bound review replan

This contract does not reconstruct or overwrite the lost historical v307 plan.
It retains only bounded fields from future structured review-plan rejections.

## Private diagnostic evidence

`rejected-review-evidence.js` allowlists task/version, execution/attempt,
continuation and plan fingerprints, approved paths/constraint/finding identifiers,
test name, literal source excerpt, stimulus/observable/assertion, source hashes,
and evaluated validator subclauses. It drops unknown response fields, rationale,
provider payloads, and reasoning. It caps five coverage records, eight mutation
paths, four focused-test paths, per-field bytes, and the whole envelope (96 KiB).
Obvious token/credential literals are redacted; binary/unprintable or oversized
fields are omitted with explicit bounded reason codes. Redaction/omission means
the field is not an exact recoverable original. No heuristic filter can prove
that arbitrary text contains no possible secret; retention remains allowlisted,
bounded, private and diagnostic-only.

Private data travels from planner errors through a WeakMap, not enumerable error
properties or safeDiagnostics. The worker checks execution identity before
writing a branded, integrity-checked envelope into a separate storage collection
or `nova_rejected_review_evidence` table (schema version 8). Exact duplicates do
not overwrite the first envelope. Public task steps retain only an evidence ID
and persistence status. Activity, task listings and approvals do not contain the
private envelope. Storage failures preserve rejection and stop the generation;
they do not grant a retry. No historical record is backfilled.

The only HTTP read path is:

`GET /api/admin/self-development/tasks/:taskId/rejected-plan-evidence/:id`

It requires the existing separately configured worker-administrator credential,
then checks the task and envelope against the server's configured owner. A local
worker credential alone cannot read it. There is no broad evidence listing or
write endpoint. Responses are no-store, nosniff JSON with HTML-sensitive characters
escaped. Diagnostic clients must render decoded strings as text, never innerHTML
or executable source. The fixed fields `diagnosticOnly:true`,
`executionAuthorized:false`, and `mutationApplied:false` confer no authority;
none of the execution/recovery validators consume this private collection.

## Distinct successor

Class: `owner_approved_evidence_bound_review_replan`

Approval tool: `self_development_evidence_bound_review_replan`

Task-scoped POST routes:

- `request-evidence-bound-review-replan`
- `recover-evidence-bound-review-replan`

Both use existing authenticated, signed local-workspace proof. The first only
requests a separate exact owner approval. Approving does not run the task. The
second requires that approval and an unchanged source state, then consumes it via
the existing compare-and-swap same-task transition. This implementation turn does
not authorize calling either route for the real task.

Eligibility is limited to the v307-shaped pre-mutation named-test coverage
rejection of the consumed source-bound review-replan predecessor. It binds the
exact failed execution, original review/constraints, repository, product branch,
product HEAD/live tip, workspace, runtime, eight current file hashes, completed
reads, dirty lineage, counters and all prior consumed histories. It does not
reinterpret arbitrary scope failures as eligible. No task ID or SHA is hardcoded.

The existing 15-minute, 13-step lifecycle is retained:

1. Eight complete current-byte reads, each bound to the existing task-owned hashes.
2. One fresh Nova plan, with source-bound behavioral coverage validation.
3. One plan-validation step.
4. One Nova apply.
5. One focused-test run.
6. One full-suite run using the existing runner contract.

The planner distinguishes mutation paths, focused-test paths, acceptance mappings,
review coverage, actual named test declarations, bounded excerpts and same-test
stimulus/assertion evidence. It receives current bytes and original findings,
not Codex-authored product replacements or mappings. Validation is not weakened.

Planning rejection retains private diagnostic fields and stops at a product
remediation decision. Focused/full failure retains bounded test evidence and
stops. Success stops at fresh `review_ready`; findings remain unresolved pending
independent review. No automatic retry, second successor use, additional repair
attempt/extension, counter reset, ninth file, commit, push or deployment is allowed.

The synthetic v307 fixture exercises the complete valid lifecycle, rejection
retention and administrator-only access, scope/hash drift, prior approval reuse,
replay, focused/full failures and preserved consumed histories. It operates only
on disposable fixture repositories and in-memory task records, never the real
Nova workspace or durable task.
