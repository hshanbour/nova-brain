import { ValidationError } from "./validation.js";

export async function readJsonBody(request, maxBodyBytes) {
  const contentType = request.headers?.["content-type"] || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ValidationError("Content-Type must include application/json.");
  }

  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;

    if (size > maxBodyBytes) {
      throw new ValidationError("Request body is too large.");
    }

    chunks.push(bytes);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  if (!raw.trim()) {
    throw new ValidationError("Request body must not be empty.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("Request body must contain valid JSON.");
  }
}
