import { createServer } from "node:http";
import { createApp } from "./app.js";
import { createStaticFileHandler } from "./http/static-files.js";

const app = createApp();
const port = Number(process.env.PORT || 3000);
const serveStatic = createStaticFileHandler();

createServer(async (request, response) => {
  if (await serveStatic(request, response)) return;
  return app.handle(request, response);
}).listen(port, () => {
  console.log(`Nova Brain listening on port ${port}`);
});
