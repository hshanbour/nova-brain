# Source-bound review replan

`owner_approved_source_bound_review_replan` is a distinct, separately approved,
single-use generation for a rejected source-bound review plan. It does not
reactivate its consumed rejected-review-plan predecessor or grant a repair-limit
extension. Historical source records remain immutable.

Protected routes:

- `POST /api/admin/self-development/tasks/:id/request-source-bound-review-replan`
- `POST /api/admin/self-development/tasks/:id/recover-source-bound-review-replan`

Both require the existing local-worker credential and a signed current workspace
proof. Requesting `self_development_source_bound_review_replan` creates only a
pending exact owner/project/task approval. The normal owner decision does not
resume or execute the task. Recovery separately verifies that approval and the
current source state, then creates one compare-and-swap continuation.

The 15-minute, 13-step scope comprises eight complete exact-byte local reads,
one Nova replan, one pre-mutation validation, one apply, one selected focused-test
run and one full-suite run. New reads bind current verified bytes without
rewriting the predecessor's eight reads. Planning, worker dispatch, handoff and
Hands select the new descriptor before retained historical scopes. The first
valid worker binds once; another worker, generation or runtime fails closed.

The accepted plan must satisfy the unchanged source-bound coverage requirements.
The runtime never fills Nova's coverage mapping or product implementation. Its
selected behavioral tests must actually execute; green counts alone are not
enough. Full testing retains `npm test` and the two-minute timeout, with a
read-only check that locked dependencies resolve in the exact worker directory.
It does not install packages or edit manifests/lockfiles.

A failed phase consumes this successor and stops at a decision boundary without
automatic retry. Full-suite success creates a fresh `review_ready` boundary with
`executionAuthorized:false` and `findingsResolved:false`; independent review is
still required. The exact eight-file scope, repair counters and all consumed
authorizations remain bound. No ninth file, new repair extension, product commit,
push or deployment is authorized by this continuation.

Future coverage rejections retain `diagnostics.coverageDiagnostics` (version 1):
approved constraint/finding/source identifiers, scoped proposed mutation/test
paths, expected and supplied test-source hashes, ordered evaluated boolean
subclauses, the exact first failure, and the plan fingerprint/current generation.
Later clauses or constraints are explicitly unevaluated after the first failure.
Unknown model identifiers are represented only by bounded fingerprints/counts;
source excerpts, assertion text, test names and model rationale are not retained.
This does not change the existing validation predicates or backfill historical
v279 diagnostics. A plan rejected before generation has no plan-generation ID;
its proposal fingerprint and active continuation generation remain available.

The source-bound fixture derives v279 through both real predecessor lifecycle
implementations, then exercises the new generation in an isolated temporary Git
workspace using the normal planner, API, worker, handoff and Hands paths. Its
synthetic model output is only a contract probe, not Nova's product solution.
Run `node --test test/review-coverage-diagnostics.test.js
test/source-bound-review-*.test.js` for focused coverage, followed by `npm test`
for full discovery. These tests do not execute the real task or grant it approval.
