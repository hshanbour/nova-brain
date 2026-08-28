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

test("health endpoint returns an online response", async () => {
  const app = createApp({ environment: {} });
  const res = response();

  await app.handle(request({ method: "GET", url: "/" }), res);

  assert.equal(res.statusCode, 200);
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
