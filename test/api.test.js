import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";

function request({ method, url, body, headers = {} }) {
  const stream = Readable.from(body ? [body] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function response() {
  const headers = new Map();
  let body = "";

  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(value = "") {
      body += value;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    }
  };
}

test("health endpoint returns an online response with defensive headers", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "GET", url: "/api/health" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(JSON.parse(res.body), {
    name: "Nova Brain",
    status: "online",
    provider: "mock",
    storage: { provider: "memory", durable: false, status: "ready" }
  });
});

test("agent endpoint validates and processes JSON input", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/agent",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello Brian" })
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).message, "Nova is ready. I received: Hello Brian");
});

test("API rejects malformed JSON", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/agent",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {
    error: "Request body must contain valid JSON."
  });
});

test("API rejects JSON bodies over the configured limit", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/agent",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(64 * 1024) })
    }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "Request body is too large." });
});

test("CORS allows configured origins and rejects unconfigured origins", async () => {
  const app = createApp({
    environment: { CORS_ALLOWED_ORIGINS: "https://allowed.example" }
  });
  const allowed = response();
  const rejected = response();

  await app.handle(
    request({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://allowed.example" }
    }),
    allowed
  );
  await app.handle(
    request({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://rejected.example" }
    }),
    rejected
  );

  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.equal(allowed.headers.get("vary"), "Origin");
  assert.equal(rejected.headers.has("access-control-allow-origin"), false);
});

test("missed-call endpoint validates and accepts placeholder intake", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(
    request({
      method: "POST",
      url: "/api/missed-call",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A customer", phone: "+441234567890" })
    }),
    res
  );

  assert.equal(res.statusCode, 202);
  assert.deepEqual(JSON.parse(res.body), {
    success: true,
    message: "Missed call received",
    lead: { name: "A customer", phone: "+441234567890" }
  });
});

test("unknown API routes return a defensive JSON 404", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "GET", url: "/api/unknown" }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(JSON.parse(res.body), { error: "Not found" });
});

test("API root is not used as the landing page or health endpoint", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "GET", url: "/" }), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: "Not found" });
});

test("owner profile and memory APIs expose controlled private CRUD", async () => {
  const app = createApp({ environment: {} });
  const profile = response();
  await app.handle(request({ method: "GET", url: "/api/owner/profile" }), profile);
  assert.equal(JSON.parse(profile.body).owner.fullName, "Mohammad Shanbour");
  assert.equal(profile.headers.get("cache-control"), "no-store");

  const created = response();
  await app.handle(request({ method: "POST", url: "/api/memories", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "preference", content: "Prefer compact release notes", scope: "global" }) }), created);
  assert.equal(created.statusCode, 201);
  const memory = JSON.parse(created.body).memory;
  assert.equal(memory.provenance, "owner-explicit");
  assert.equal(memory.privacy, "private");

  const updated = response();
  await app.handle(request({ method: "PATCH", url: `/api/memories/${memory.id}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "project", projectId: "nova-brain" }) }), updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(JSON.parse(updated.body).memory.projectId, "nova-brain");

  const removed = response();
  await app.handle(request({ method: "DELETE", url: `/api/memories/${memory.id}` }), removed);
  assert.deepEqual(JSON.parse(removed.body), { success: true });
});

test("memory API rejects unsupported categories and invalid project scope", async () => {
  const app = createApp({ environment: {} });
  for (const payload of [
    { category: "secret_model_fact", content: "unsafe", scope: "global" },
    { category: "goal", content: "missing project", scope: "project" }
  ]) {
    const res = response();
    await app.handle(request({ method: "POST", url: "/api/memories", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), res);
    assert.equal(res.statusCode, 400);
  }
});

test("storage failures are fail-closed and health reports degradation", async () => {
  const storage = Object.freeze({ provider: "postgres", durable: true, async initialize() { throw new Error("database-secret-value"); }, async health() { throw new Error("database-secret-value"); } });
  const app = createApp({ environment: {}, storage });
  const health = response(); await app.handle(request({ method: "GET", url: "/api/health" }), health);
  assert.deepEqual(JSON.parse(health.body).storage, { provider: "postgres", durable: true, status: "degraded" });
  const profile = response(); await app.handle(request({ method: "GET", url: "/api/owner/profile" }), profile);
  assert.equal(profile.statusCode, 503);
  assert.equal(profile.body.includes("database-secret-value"), false);
});
