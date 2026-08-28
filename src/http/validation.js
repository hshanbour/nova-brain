export class ValidationError extends Error {}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value, field, { maxLength = 500 } = {}) {
  if (value === undefined) return undefined;

  if (typeof value !== "string" || value.length > maxLength) {
    throw new ValidationError(`${field} must be a string up to ${maxLength} characters.`);
  }

  return value.trim();
}

export function validateAgentRequest(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const message = optionalString(value.message, "message", { maxLength: 4_000 });

  if (!message) {
    throw new ValidationError("message is required.");
  }

  const conversationId = optionalString(value.conversationId, "conversationId", {
    maxLength: 128
  });
  const context = value.context === undefined ? {} : value.context;

  if (!isPlainObject(context)) {
    throw new ValidationError("context must be a JSON object.");
  }

  return { message, ...(conversationId ? { conversationId } : {}), context };
}

export function validateMissedCallRequest(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  return {
    name: optionalString(value.name, "name", { maxLength: 200 }) || "Unknown",
    phone: optionalString(value.phone, "phone", { maxLength: 64 }) || null
  };
}
