import { RISK_LEVELS } from "../policy/action-policy.js";
const schema = (properties = {}, required = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }),
  text = { type: "string" },
  number = { type: "number" };
export function registerWorkerTools(registry, { runtime, taskMigration }) {
  registry.register({
    name: "autonomy_task_create",
    description: "Create a bounded durable autonomous task.",
    category: "autonomy",
    capability: "write",
    riskLevel: RISK_LEVELS.LOW_RISK_WRITE,
    autonomous: true,
    available: true,
    configurationStatus: "ready",
    inputSchema: schema(
      {
        title: text,
        objective: text,
        taskType: text,
        projectId: text,
        priority: number,
        maxSteps: number,
        maxRetries: number,
        maxRuntimeMinutes: number,
        branch: text,
        startingCommit: text,
        metadata: { type: "object" },
      },
      ["title", "objective"],
    ),
    execute: (input) => runtime.create(input),
  });
  registry.register({
    name: "autonomy_task_list",
    description: "List durable autonomous tasks.",
    category: "autonomy",
    capability: "read",
    riskLevel: RISK_LEVELS.READ_ONLY,
    available: true,
    configurationStatus: "ready",
    inputSchema: schema({ status: text, limit: number }),
    execute: (input) => runtime.list(input),
  });
  registry.register({
    name: "autonomy_task_get",
    description: "Inspect one autonomous task and checkpoint.",
    category: "autonomy",
    capability: "read",
    riskLevel: RISK_LEVELS.READ_ONLY,
    available: true,
    configurationStatus: "ready",
    inputSchema: schema({ taskId: text }, ["taskId"]),
    async execute({ taskId }) {
      return {
        task: await runtime.get(taskId),
        steps: await runtime.steps(taskId),
      };
    },
  });
  for (const action of ["pause", "resume", "cancel"])
    registry.register({
      name: `autonomy_task_${action}`,
      description: `${action} a durable autonomous task.`,
      category: "autonomy",
      capability: "write",
      riskLevel: RISK_LEVELS.LOW_RISK_WRITE,
      autonomous: true,
      available: true,
      configurationStatus: "ready",
      inputSchema: schema({ taskId: text }, ["taskId"]),
      execute: ({ taskId }) => runtime.control(taskId, action),
    });
  registry.register({
    name: "autonomy_worker_tick",
    description: "Advance at most one bounded autonomous task step.",
    category: "autonomy",
    capability: "execute",
    riskLevel: RISK_LEVELS.LOW_RISK_WRITE,
    autonomous: true,
    available: true,
    configurationStatus: "ready",
    inputSchema: schema({ idempotencyKey: text }),
    execute: (input) => runtime.tick(input),
  });
  if (taskMigration)
    registry.register({
      name: "worker_task_migrate",
      description: "Apply one allowlisted durable Worker task migration.",
      category: "autonomy",
      capability: "admin",
      riskLevel: RISK_LEVELS.HIGH_IMPACT,
      available: true,
      configurationStatus: "scoped_admin_only",
      inputSchema: schema(
        {
          taskId: text,
          migrationType: text,
          expectedBranch: text,
          expectedCommit: text,
          targetCommit: text,
          runtimeMinutes: number,
          planVersion: text,
        },
        [
          "taskId",
          "migrationType",
          "expectedBranch",
          "expectedCommit",
          "targetCommit",
          "runtimeMinutes",
          "planVersion",
        ],
      ),
      execute: (input) =>
        taskMigration.migrate(input, { actorType: "approved_internal_tool" }),
    });
}
