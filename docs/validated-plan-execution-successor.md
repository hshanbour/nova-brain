# Owner-approved validated-plan execution successor

This is a separate execution authorization, not a repair-limit exception or a
renewal of a consumed planning continuation. Installing this code grants no
execution authority and changes no real task.

## Boundary and identity

An eligible task is blocked immediately after its sole planning successor's
successful `plan_repair → validate_patch`. Both steps, the unchanged active
planning-only plan, exact current complete reads, whole task-owned dirty set and
the prior approved planning record must agree. Historical planning timestamps
are verified as history; their expired window is never renewed.

Product repository, branch, starting/current HEAD, live feature tip and canonical
workspace are checked independently from the active control-plane runtime SHA.
The new runtime must be the verified control-plane tip and descend from the
previous runtime. Existing counters and consumed authorization records remain
unchanged.

## Explicit authorization flow

Both protected routes require the existing worker bearer credential and signed
current workspace proof. Actual execution retains the existing handoff guard
that forbids Production.

1. `POST /api/admin/self-development/tasks/:id/request-execution-scope-recovery`
   with `expectedVersion`, exact `planHash`, `runtimeVersion`, `workspaceProof`
   and `workspaceProofSignature` creates only an approval request. It does not
   change or resume the task. An exact duplicate returns the same request.
2. An independent owner decision approves the generated
   `self_development_execution_scope_recovery` approval. The normal approval
   decision route records this decision only; it does not start execution.
3. `POST /api/admin/self-development/tasks/:id/recover-execution-scope` adds
   `approvalId` to that exact request, revalidates all bindings and consumes it
   once through the task's versioned compare-and-swap.

The approval binds the full validated plan and replacement payload hashes, exact
existing path set, focused-test list, pre/post byte evidence, source validation,
task version, workspace, product identity and active runtime. A stale approval,
different plan, widened scope or a second successor is rejected.

## Execution limits

The successor has a 15-minute window and exactly two steps:

`apply_patch → run_focused_tests`

One fresh authenticated persistent worker binds atomically on its first claim.
Each step is reserved once. The worker and Hands independently verify the scoped
handoff identity. Hands checks complete local byte evidence, repository HEAD,
live branch tip, exact replacement payload and syntax before applying. Tests
must be the exact approved list, without a name filter, and run only against the
verified post-apply bytes. No unrelated dirty/staged path is permitted.

The original plan remains `planningOnly:true`; only the separately approved
execution contract permits this one application. Historical steps, reads,
lineage, counters and consumed approvals are not rewritten.

Successful focused tests leave the task blocked at `focused_tests_completed`.
A failure or expired claimed handoff stops without automatic retry, replan,
counter reset, repair extension or runtime renewal. There is no full-suite,
commit, push, deployment or further product-repair authority in this contract.
Those actions require a separately supported and explicitly authorized next step.

The regression suite uses synthetic repositories and in-memory task storage;
it never runs the real Nova successor.
