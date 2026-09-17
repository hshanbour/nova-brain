# Owner-approved review remediation

`owner_approved_review_remediation` is a separate, single-use authorization for
a reviewed but undeliverable candidate. It is not another repair-limit exception
and does not reopen any consumed planning, execution, or full-test successor.
Implementation or deployment of this infrastructure does not authorize execution.

## Source and owner decision

The source is the blocked `review_ready` boundary after a consumed, successful
failed-full-test retry. The live v223 shape has completed focused and full test
evidence, no lease or handoff, and no delivery authority. Eligibility independently
validates that historical predecessor at its original execution time, all source
step hashes, complete task-owned dirty lineage, and the current signed eight-file
workspace proof. The live product branch tip and approved control-plane runtime
are verified separately. A runtime SHA is never the expected product HEAD.

The authenticated worker may request an approval using:

`POST /api/admin/self-development/tasks/:id/request-review-remediation`

The request includes `expectedVersion`, source `planHash`, `runtimeVersion`, the
signed `workspaceProof`, and structured `review`. Four blocking findings and at
most one non-blocking note are accepted. Each finding has an ID, severity, bounded
paths, concise factual defect, current content-hash/line references, and acceptance
implication. Five acceptance constraints bind their IDs and finding IDs. Arbitrary
analysis or chain-of-thought is not a supported evidence field.

The ordinary owner approval decision records authorization only; it does not
resume the task. The separately invoked authenticated
`POST /api/admin/self-development/tasks/:id/recover-review-remediation` must supply
the exact approved request and approval ID. Workspace, review, source evidence, or
runtime drift invalidates the approval. A second successor cannot be created.

## One bounded cycle

The window is 15 minutes with exactly 13 executable steps:

1. Eight complete, task-owned local file reads.
2. One Nova-generated remediation plan.
3. One plan validation.
4. One application of a nonempty subset of the approved eight paths.
5. One focused-test run.
6. One full-suite run using the existing `npm test` command and timeout.

The eight-path authorization and complete before/after lineage remain fixed even
when Nova chooses to modify fewer paths. Fresh current bytes and hashes are the
mutation precondition. Exact committed-HEAD content for those same paths may
accompany the reads as diagnostic baseline evidence; it never substitutes for
current workspace evidence. An untracked path has no committed baseline.

The new explicit scope takes precedence over retained historical scopes in
auto-dispatch, server planning, local handoff, worker execution, and Hands. The
first authenticated worker binds once. Steps are reserved before execution;
competing workers, retries, replay, stale generations, and expiration fail closed.
Consumed predecessor histories and repair counters remain unchanged. Active plan
lifecycle supersession is limited to the single new plan, with its original source
snapshot retained in the remediation record.

## Review acceptance and safe stopping

Nova's plan must map every approved acceptance constraint to a named in-scope
focused test, exact test-source hash and excerpt, stimulus, observable, and literal
assertion. The planner receives the findings, current and committed baseline
evidence, and the requirement for meaningful behavioral coverage. The infrastructure
does not supply the product implementation or regard a token-only check or an
unwired counter as meaningful review evidence.

Nova supplies the source references; the runtime computes their hashes from the
exact generated or freshly read test source. Focused success requires an
untruncated transcript proving every named coverage test actually executed.
Historical and new full-suite output may be bounded by Hands only when the
complete passing terminal Node summary is retained, with no skipped, cancelled,
or todo tests. A partial summary or earlier embedded counters are insufficient.

The live review constraints concern preserving existing console functionality,
manual-send endpoint/response/conversation behavior, stale capture-request resource
isolation, observable no-auto-send behavior, and equivalent meaningful regression
coverage. Nova decides the product repair within the eight-file scope. If a ninth
file is necessary, execution stops for a new owner scope decision.

Passing focused and full tests produces a fresh blocked `review_ready` boundary
with `executionAuthorized:false`. Findings remain unresolved pending independent
review: source bindings and passing tests do not prove semantic correctness or
actual browser/microphone acceptance. A failed phase consumes this cycle and stops
at a decision boundary. It cannot automatically replan, repair, or rerun tests.

There is no commit, push, deployment, repair-extension, or subsequent execution
authority in this successor. Main, Production, and out-of-scope product paths are
not authorized.

## Verification

The isolated v223-shaped fixture derives the source through the real predecessor
lifecycles, then exercises approval, fresh reads, Nova planner, validation, Hands
application, focused tests, full tests, and the new blocked review boundary. It
also checks source/workspace/lineage drift, stale findings, replay, scope expansion,
focused/full failure, and immutable consumed histories. All fixture product data
is synthetic; running these tests does not execute the real Nova task.

## Infrastructure change manifest

- `src/autonomy/review-remediation-scope.js`
- `src/autonomy/self-development.js`
- `src/autonomy/self-development-implementation-planner.js`
- `src/autonomy/auto-dispatch.js`
- `src/autonomy/worker-runtime.js`
- `src/autonomy/local-worker-handoff.js`
- `src/autonomy/persistent-local-worker.js`
- `src/http/api.js`
- `src/tools/hands-runtime.js`
- `test/review-remediation-scope.test.js`
- `test/review-remediation-api.test.js`
- `test/review-remediation-e2e.test.js`
- `test/review-remediation-handoff.test.js`
- `test/review-remediation-worker-context.test.js`
- `test/review-remediation-fixture.js`
- `test/execution-scope-fixture.js`
- `test/full-test-scope-fixture.js`
- `test/failed-full-test-retry-fixture.js`
- `docs/review-remediation-successor.md`
