import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT || 3000);
const landingPage = await readFile(new URL("../index.html", import.meta.url));

createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;

  if (request.method === "GET" && pathname === "/") {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(landingPage);
    return;
  }

  return app.handle(request, response);
}).listen(port, () => {
  console.log(`Nova Brain listening on port ${port}`);
});
