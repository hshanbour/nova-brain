import { createServer } from "node:http";
import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT || 3000);

createServer((request, response) => app.handle(request, response)).listen(port, () => {
  console.log(`Nova Brain listening on port ${port}`);
});
