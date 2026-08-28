import { readJsonBody } from "./body.js";
import {
  ValidationError,
  validateAgentRequest,
  validateMissedCallRequest
} from "./validation.js";

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(request, response, allowedOrigins) {
  const origin = request.headers?.origin;

  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

export function createApi({ agent, config }) {
  return Object.freeze({
    async handle(request, response) {
      setCorsHeaders(request, response, config.allowedOrigins);

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.end();
        return;
      }

      const pathname = new URL(request.url || "/", "http://localhost").pathname;

      try {
        if (request.method === "GET" && pathname === "/api/health") {
          sendJson(response, 200, {
            name: "Nova Brain",
            status: "online",
            provider: config.modelProvider
          });
          return;
        }

        if (request.method === "POST" && pathname === "/api/agent") {
          const input = validateAgentRequest(
            await readJsonBody(request, config.maxBodyBytes)
          );
          const result = await agent.run(input);
          sendJson(response, 200, result);
          return;
        }

        if (request.method === "POST" && pathname === "/api/missed-call") {
          const lead = validateMissedCallRequest(
            await readJsonBody(request, config.maxBodyBytes)
          );
          sendJson(response, 202, {
            success: true,
            message: "Missed call received",
            lead
          });
          return;
        }

        sendJson(response, 404, { error: "Not found" });
      } catch (error) {
        if (error instanceof ValidationError) {
          sendJson(response, 400, { error: error.message });
          return;
        }

        console.error("Nova Brain request failed", error);
        sendJson(response, 500, { error: "Internal server error" });
      }
    }
  });
}
