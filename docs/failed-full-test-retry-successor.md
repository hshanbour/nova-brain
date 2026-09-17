# Owner-approved failed-full-test retry

This infrastructure does not execute or authorize the real task by installation.
It adds a separate `owner_approved_failed_full_test_retry` successor after a
consumed full-test-only successor stopped at `product_repair_decision` with a
durable missing-dependency failure. It does not reopen the consumed predecessor.

## Source evidence and approval

The source must be the same blocked self-development task in `run_full_tests`,
with the exact completed failed full-test step, an unchanged validated plan and
previously passing focused tests. The failed result, its fingerprint, prior
successor, complete task-owned workspace hashes/lineage, product identity and
all consumed authorizations remain immutable evidence. There can be no later
execution or unproven workspace change.

1. `POST /api/admin/self-development/tasks/:id/request-failed-full-test-retry`
   with `expectedVersion`, `planHash`, `runtimeVersion`, `workspaceProof` and
   `workspaceProofSignature`. Authentication and signed current workspace proof
   are required. This creates only a pending exact approval; duplicate requests
   reuse the matching pending/approved request without task mutation.
2. Independently approve that `self_development_failed_full_test_retry` record.
   The decision is record-only: it never starts or resumes the worker/task.
3. `POST /api/admin/self-development/tasks/:id/recover-failed-full-test-retry`
   with the same bindings and `approvalId`. A compare-and-swap records the single
   retry generation in `failedFullTestRetryHistory`. A second successor or reuse
   of the previous consumed full-test successor is rejected.

Product HEAD/live branch tip and control-plane runtime SHA are independent,
verified identities. The predecessor's historical runtime is evidence, not the
expected product HEAD. The new approval must bind the current runtime.

## Exactly one command, with dependency preflight

The successor has one executable test step and a five-minute window. It permits
only the existing unfiltered `npm test` command with its unchanged 120-second
timeout. It grants no product mutation, apply, focused rerun, replanning, repair
attempt/extension, commit, push or deployment authority.

Before the full-suite command, the authenticated worker must verify that
`@neondatabase/serverless` resolves from the exact bound product working
directory. The preflight neither installs packages nor edits manifests or
lockfiles. Missing resolution reports `dependency_provisioning_required` and
does not invoke `npm test`.

The existing security model reserves one claim before local execution. Therefore
even a dependency-preflight failure consumes that reservation and stops at an
infrastructure boundary; it does **not** consume a test execution (zero npm
commands run), but the successor cannot replay. This deliberately preserves
crash/replay protection rather than silently granting another worker attempt.
Provisioning must be verified operationally before authorizing/claiming a retry.

The worker binds once, rejects old/competing worker identities, and verifies
complete raw/canonical workspace hashes before and after execution. Existing
repair/retry counters, focused results and consumed histories are preserved.

## Durable stop boundaries

- PASS: `review_ready`, with no review/delivery execution.
- Test FAIL: `product_repair_decision`, with no new repair authority.
- Dependency, runtime, timeout or workspace-proof failure: an infrastructure
  stop, never an automatic retry or an inferred product repair.

All synthetic tests use isolated repositories and in-memory storage. Their
v219-shaped predecessor has step 151 failed, 678 passed / 3 failed / 0 skipped,
seven passing focused tests, eight unchanged dirty files and a consumed prior
full-test successor. They do not execute the real v219 task.
