import { createApp } from "../src/app.js";

const app = createApp();
export const maxDuration = 300;

export default async function handler(request, response) {
  return app.handle(request, response);
}
