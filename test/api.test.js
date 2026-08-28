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
    provider: "mock"
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
  assert.equal(JSON.parse(res.body).message, "Brian is ready. I received: Hello Brian");
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
