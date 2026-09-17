# Rejected review-plan continuation

`owner_approved_rejected_review_plan_continuation` is a separate single-use
owner-approved execution generation. It is not a generic resume, retry,
repair-limit extension, or reuse of the consumed review-remediation approval.

## Source contract

The source is the blocked post-planning decision produced by one consumed
`owner_approved_review_remediation` generation: eight completed local reads,
one failed `plan_repair` attempt, `review_remediation_precondition_failed` /
`complete_behavioral_coverage`, and durable `mutationApplied:false`. The source
has no accepted replacement plan, later execution, lease, local handoff or
pending task approval. The real source shape is v251, current step160,
failed161, with repairIteration3.

Eligibility verifies the original generation at its recorded execution time in
an in-memory projection. This does not rewrite historical records or make the
old authority executable. Original read contents, raw Git blob hashes, canonical
content hashes, source plan/apply fingerprints, source test evidence, approved
review, consumed predecessor approvals and all prior histories remain bound.
The rejected plan fingerprint and exact failed-step/read/boundary hashes are
included in the new approval identity. The new runtime and live product branch
are independently verified; the runtime SHA is not the product HEAD.

Protected routes:

- `POST /api/admin/self-development/tasks/:id/request-rejected-review-plan-continuation`
- `POST /api/admin/self-development/tasks/:id/recover-rejected-review-plan-continuation`

Both require existing local-worker authentication and a signed current workspace
proof. Requesting approval does not resume the task. Approving
`self_development_rejected_review_plan_continuation` records authority only.
Recovery separately requires that exact owner/project/task approval, matching
arguments and expected stateVersion, then performs one compare-and-swap.

## One bounded execution

The 15-minute window authorizes exactly 13 executable steps:

1. Eight fresh complete local reads, requiring the original exact eight dirty
   paths and hashes. Historical reads remain immutable; new reads bind verified
   current bytes to the new generation. Any byte or scope drift stops execution.
2. One Nova-generated remediation plan containing one unique coverage entry per
   approved constraint. Nova receives the unchanged review, current contents,
   committed baselines and current lineage evidence. No coverage is auto-filled.
3. One pre-mutation validation.
4. One apply of Nova's validated nonempty subset of the eight authorized paths.
5. One focused-test execution for the accepted plan's selected test files.
6. One full-suite execution using the existing `npm test` and two-minute timeout.

No ninth file, package manifest, lockfile, commit, push or deployment is
authorized. Complete before/after eight-file lineage is retained even when the
mutation set is smaller. Prior repair counters, consumed repair extension and
all predecessor generations stay unchanged. The first authenticated worker binds
once; different workers, stale contexts, replay and expired windows fail closed.

The new descriptor has precedence over retained historical scopes through
planning, dispatch, worker handoff and Hands. Plan hashes include review coverage;
they are not interchangeable with older planning-only execution successors.
Focused success requires the named behavioral coverage tests to have actually
executed, not merely passing counts. Before the full suite, a read-only preflight
checks locked direct dependencies in the exact worker cwd. It never installs
packages or changes manifests/lockfiles. Missing dependencies stop the consumed
phase before npm runs. The existing runtime-time and workspace-drift checks
remain in force.

Any failed planning, validation, apply or test phase consumes this generation and
stops at a decision boundary without retry, replanning or a new repair extension.
A passing full suite stops at a fresh `review_ready` boundary with
`executionAuthorized:false` and `findingsResolved:false`. Independent review and
real browser acceptance are still required; infrastructure fixtures do not prove
the microphone product correct.

## Verification and operational separation

The v251 fixture derives its consumed predecessor and rejected planning state
through the real synthetic worker lifecycle, rather than assigning a version or
fabricating an accepted plan. It then exercises the new protected approval path,
current-byte reads, model-provider boundary, validation, Hands apply, actual Node
focused tests and actual npm full tests in an isolated temporary repository.
Failure/replay/scope/hash/authentication cases leave real product files and the
real task untouched. Runtime implementation and local commit do not authorize
executing this continuation; operational owner approval is a separate step.
