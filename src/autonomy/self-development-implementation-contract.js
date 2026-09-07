export const SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA_VERSION = "1";

// Single server/worker boundary for a validated implementation plan.
export const SELF_DEVELOPMENT_HANDS_PATCH_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    branch: { type: "string" },
    currentCommit: { type: "string" },
    files: { type: "array" },
  },
  required: ["branch", "files"],
  additionalProperties: false,
});
