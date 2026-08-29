import { readJsonBody } from "./body.js";
import { AgentStepLimitError, AgentToolCallLimitError } from "../agent/agent.js";
import {
  ValidationError,
  validateAgentRequest,
  validateMissedCallRequest,
  validateOwnerProfilePatch,
  validateMemoryCreate,
  validateMemoryPatch,
  validateListLimit,
  validateListOffset
} from "./validation.js";

class StorageUnavailableError extends Error {}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(request, response, allowedOrigins) {
  const origin = request.headers?.origin;

  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

export function createApi({ agent, config, storage, initialize, ownerId }) {
  return Object.freeze({
    async handle(request, response) {
      setCorsHeaders(request, response, config.allowedOrigins);

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.end();
        return;
      }

      const url = new URL(request.url || "/", "http://localhost");
      const pathname = url.pathname;

      const ready = async () => {
        try { await initialize(); }
        catch { throw new StorageUnavailableError("Storage is unavailable."); }
      };

      try {
        if (request.method === "GET" && pathname === "/api/health") {
          let storageHealth;
          try { await ready(); storageHealth = await storage.health(); }
          catch { storageHealth = { provider: storage.provider, durable: storage.durable, status: "degraded" }; }
          sendJson(response, 200, {
            name: "Nova Brain",
            status: "online",
            provider: config.modelProvider,
            storage: storageHealth
          });
          return;
        }

        if (request.method === "POST" && pathname === "/api/agent") {
          await ready();
          const input = validateAgentRequest(
            await readJsonBody(request, config.maxBodyBytes)
          );
          const result = await agent.run(input);
          sendJson(response, 200, result);
          return;
        }

        if (request.method === "GET" && pathname === "/api/owner/profile") {
          await ready(); sendJson(response, 200, { owner: await storage.getOwner(ownerId) }); return;
        }

        if (request.method === "PATCH" && pathname === "/api/owner/profile") {
          await ready(); const patch = validateOwnerProfilePatch(await readJsonBody(request, config.maxBodyBytes));
          sendJson(response, 200, { owner: await storage.updateOwner(ownerId, patch) }); return;
        }

        if (request.method === "GET" && pathname === "/api/memories") {
          await ready(); const limit = validateListLimit(url.searchParams.get("limit"), 100, 200);
          const memories = await storage.listMemories(ownerId, { category: url.searchParams.get("category") || undefined, scope: url.searchParams.get("scope") || undefined, projectId: url.searchParams.get("projectId") || undefined, limit });
          sendJson(response, 200, { memories }); return;
        }

        if (request.method === "POST" && pathname === "/api/memories") {
          await ready(); const input = validateMemoryCreate(await readJsonBody(request, config.maxBodyBytes));
          sendJson(response, 201, { memory: await storage.createMemory({ ...input, ownerId }) }); return;
        }

        const memoryMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
        if (memoryMatch && request.method === "PATCH") {
          await ready(); const patch = validateMemoryPatch(await readJsonBody(request, config.maxBodyBytes));
          const memory = await storage.updateMemory(decodeURIComponent(memoryMatch[1]), ownerId, patch);
          sendJson(response, memory ? 200 : 404, memory ? { memory } : { error: "Memory not found" }); return;
        }
        if (memoryMatch && request.method === "DELETE") {
          await ready(); const deleted = await storage.deleteMemory(decodeURIComponent(memoryMatch[1]), ownerId);
          sendJson(response, deleted ? 200 : 404, deleted ? { success: true } : { error: "Memory not found" }); return;
        }

        if (request.method === "GET" && pathname === "/api/conversations") {
          await ready(); const limit = validateListLimit(url.searchParams.get("limit"), 20, 100);
          sendJson(response, 200, { conversations: await storage.listConversations(ownerId, { limit }) }); return;
        }

        const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if (conversationMatch && request.method === "GET") {
          await ready(); const limit = validateListLimit(url.searchParams.get("limit"), 100, 100); const offset = validateListOffset(url.searchParams.get("offset"));
          const messages = await storage.listMessages(decodeURIComponent(conversationMatch[1]), ownerId, { limit, offset });
          sendJson(response, 200, { messages, ...(messages.length === limit ? { nextOffset: offset + limit } : {}) }); return;
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

        if (error instanceof StorageUnavailableError) {
          sendJson(response, 503, { error: "Nova's private storage is temporarily unavailable." }); return;
        }

        if (
          error instanceof AgentStepLimitError ||
          error instanceof AgentToolCallLimitError
        ) {
          sendJson(response, 502, { error: error.message });
          return;
        }

        console.error("Nova Brain request failed", { name: error?.name || "Error" });
        sendJson(response, 500, { error: "Internal server error" });
      }
    }
  });
}
