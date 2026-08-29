import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { selectWorkspace } from "../assets/workspace-navigation.js";

function link(section) {
  const classes = new Set(); const attributes = new Map();
  return { dataset: { section }, classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } }, setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); }, getAttribute(name) { return attributes.get(name); } };
}

test("workspace selection hides every inactive workspace and synchronises desktop and mobile links", () => {
  const chat = { id: "chat", hidden: false }; const memory = { id: "memory", hidden: true };
  const links = [link("chat"), link("memory"), link("chat"), link("memory")];
  assert.equal(selectWorkspace({ workspaces: [chat, memory], links, name: "memory" }), "memory");
  assert.equal(chat.hidden, true); assert.equal(memory.hidden, false);
  assert.deepEqual(links.map((item) => item.classList.contains("active")), [false, true, false, true]);
  assert.equal(links[1].getAttribute("aria-current"), "page");
  assert.equal(selectWorkspace({ workspaces: [chat, memory], links, name: "chat" }), "chat");
  assert.equal(chat.hidden, false); assert.equal(memory.hidden, true);
  assert.deepEqual(links.map((item) => item.classList.contains("active")), [true, false, true, false]);
});

test("unknown or default workspace selection safely falls back to Chat", () => {
  const chat = { id: "chat", hidden: true }; const memory = { id: "memory", hidden: false };
  assert.equal(selectWorkspace({ workspaces: [chat, memory], links: [], name: "unknown" }), "chat");
  assert.equal(chat.hidden, false); assert.equal(memory.hidden, true);
});

test("generic hidden CSS wins over workspace display declarations", async () => {
  const css = await readFile(new URL("../assets/console.css", import.meta.url), "utf8");
  assert.match(css, /\.workspace\[hidden\]\{display:none\}/);
});
