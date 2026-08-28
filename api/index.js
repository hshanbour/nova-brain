import { createApp } from "../src/app.js";

const app = createApp();

export default async function handler(request, response) {
  return app.handle(request, response);
}
