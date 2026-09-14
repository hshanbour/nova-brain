# Owner-approved full-test-only successor

Installing this infrastructure grants no authority to run the real task. A new
explicit owner decision is required; the consumed execution predecessor is
immutable evidence, never reusable execution authority.

## Existing boundary audit

The post-focused task is blocked at `focused_tests_completed`. Generic resume
rejects its planning-scope history. Its execution successor only permitted
`apply_patch` and `run_focused_tests`, has no remaining steps, and is consumed.
Existing full-test failure/handoff recoveries require an actual failed full-test
execution. They cannot authorize a first full test at this boundary.

Successful application is proven by its completed durable step and full output
lineage. Byte-identical replacements are valid; no artificial byte change or
second application is required.

## Authorization flow

1. `POST /api/admin/self-development/tasks/:id/request-full-test-scope-recovery`
   with `expectedVersion`, `planHash`, `runtimeVersion`, `workspaceProof` and
   `workspaceProofSignature`. This protected route creates only an exact approval
   request and does not alter the task. Exact duplicates reuse that request.
2. Record the independent owner decision for the generated
   `self_development_full_test_scope_recovery` approval. The decision does not
   start, recover or execute the task.
3. `POST /api/admin/self-development/tasks/:id/recover-full-test-scope` with the
   same signed proof and `approvalId`. A versioned compare-and-swap consumes the
   approval and creates exactly one new generation.

The contract binds the task/version, active validated plan, completed apply and
focused-test results, complete current raw/canonical workspace hashes, exact
repository/branch/root/product HEAD and live branch tip. The approved runtime
commit is verified independently on the control-plane branch. Historical task
steps, counters and consumed recovery/planning/execution/repair authorizations
remain unchanged.

## One run, no repair or mutation authority

The generation has **one step and a five-minute window**: the system's minimum
continuation window, within the owner's 30-minute maximum. It uses the existing
`test_run_full` tool with exactly `{}`: `npm test`, no substituted files, filters,
timeout override or additional command. The existing 120-second test-runner
timeout remains unchanged, leaving time for worker binding and result persistence.

One fresh authenticated worker binds atomically. One claim is reserved before
execution; a lost or expired claim cannot be retried by another worker. Worker
and Hands enforce the full-test context and verify current workspace bytes before
and after the run. No apply, new planning, focused rerun, product repair, commit,
push or deployment is authorized.

## Result boundaries

- Passing full suite: persist the result and block at `review_ready`.
- Failing full suite: persist the exact available failure evidence and block at
  `product_repair_decision`. No repair is scheduled and no attempt is granted.
- Infrastructure/timeout failure: consume the single use and stop failed with
  its error. No silent retry or runtime renewal is permitted.

Review, repair and delivery are separate future authorization decisions. The
feature branch cannot be pushed without an exact owner delivery approval.

Regression fixtures use temporary synthetic repositories and in-memory durable
storage, including a real v215-shaped, byte-identical application predecessor.
They never run the real Nova full suite or edit its product workspace.
