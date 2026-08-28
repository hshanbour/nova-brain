import test from "node:test";
import assert from "node:assert/strict";
import {
  ValidationError,
  validateAgentRequest,
  validateMissedCallRequest
} from "../src/http/validation.js";

test("agent requests require a non-empty message and object context", () => {
  assert.deepEqual(validateAgentRequest({ message: " Hello ", context: {} }), {
    message: "Hello",
    context: {}
  });
  assert.throws(() => validateAgentRequest({ message: "" }), ValidationError);
  assert.throws(
    () => validateAgentRequest({ message: "Hello", context: [] }),
    ValidationError
  );
});

test("missed-call intake keeps the legacy optional fields while validating types", () => {
  assert.deepEqual(validateMissedCallRequest({}), { name: "Unknown", phone: null });
  assert.throws(() => validateMissedCallRequest({ phone: 123 }), ValidationError);
});
