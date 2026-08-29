import { createNovaClient } from "./api-client.js";
import { ownerMemoryClient } from "./memory-client.js";

const client = createNovaClient();
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const messages = document.querySelector("#messages");
const welcome = document.querySelector("#welcomeState");
const sendButton = document.querySelector("#sendButton");
const requestError = document.querySelector("#requestError");
const template = document.querySelector("#messageTemplate");
const providerStatus = document.querySelector("#providerStatus");
let pending = false;
let currentProfile;
let memoryRecords = [];
const conversationKey = "nova.activeConversationId";

function resizeInput() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 176)}px`; }
function scrollToLatest() { messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" }); }
function timeLabel() { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date()); }

function addMessage({ role, text, metadata }) {
  welcome.hidden = true;
  const node = template.content.firstElementChild.cloneNode(true);
  const isNova = role === "assistant";
  node.classList.add(isNova ? "nova-message" : "owner-message");
  node.querySelector(".avatar").textContent = isNova ? "N" : "Y";
  node.querySelector("strong").textContent = isNova ? "Nova" : "You";
  node.querySelector("time").textContent = timeLabel();
  node.querySelector(".message-body").textContent = text;
  if (metadata) {
    const meta = node.querySelector(".execution-meta");
    const toolCount = Array.isArray(metadata.toolCalls) ? metadata.toolCalls.length : 0;
    const stepCount = metadata.steps || 1;
    meta.textContent = `${metadata.provider || "Nova"} · ${stepCount} ${stepCount === 1 ? "step" : "steps"} · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
    meta.hidden = false;
  }
  messages.append(node); scrollToLatest();
}

function addThinking() {
  const node = document.createElement("article");
  node.className = "message nova-message thinking-message"; node.id = "thinkingMessage";
  node.innerHTML = '<div class="avatar">N</div><div class="message-content"><div class="message-heading"><strong>Nova</strong></div><div class="thinking"><span></span><span></span><span></span><em>Working on it</em></div></div>';
  messages.append(node); scrollToLatest();
}

function setPending(value) {
  pending = value; input.disabled = value; sendButton.disabled = value;
  sendButton.querySelector("span:first-child").textContent = value ? "Working" : "Send";
}

async function sendMessage(message) {
  requestError.hidden = true; addMessage({ role: "user", text: message }); addThinking(); setPending(true);
  try {
    const result = await client.send(message);
    localStorage.setItem(conversationKey, result.conversationId);
    document.querySelector("#thinkingMessage")?.remove();
    addMessage({ role: "assistant", text: result.message, metadata: result });
    providerStatus.textContent = `${result.provider || "Agent"} provider · Ready`;
  } catch (error) {
    document.querySelector("#thinkingMessage")?.remove(); requestError.textContent = error.message; requestError.hidden = false;
  } finally { setPending(false); input.focus(); }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault(); const message = input.value.trim(); if (!message || pending) return;
  input.value = ""; resizeInput(); sendMessage(message);
});
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } });
document.querySelector("#newChatButton").addEventListener("click", () => {
  client.reset(); localStorage.removeItem(conversationKey); messages.querySelectorAll(".message").forEach((message) => message.remove()); welcome.hidden = false;
  requestError.hidden = true; input.value = ""; resizeInput(); input.focus();
});
fetch("/api/health").then((response) => response.ok ? response.json() : Promise.reject()).then((health) => { providerStatus.textContent = `${health.provider} provider · Ready`; }).catch(() => { providerStatus.textContent = "Status unavailable"; });
resizeInput();

function showSection(name) {
  document.querySelectorAll("main.workspace").forEach((section) => { section.hidden = section.id !== name; });
  document.querySelectorAll("[data-section]").forEach((link) => { const active = link.dataset.section === name; link.classList.toggle("active", active); if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
  if (name === "memory") loadMemoryWorkspace();
}

document.querySelectorAll("[data-section]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); const name = link.dataset.section; history.replaceState(null, "", `#${name}`); showSection(name); }));

async function restoreConversation() {
  const id = localStorage.getItem(conversationKey); if (!id) return;
  try {
    const { messages: storedMessages } = await ownerMemoryClient.messages(id);
    if (!storedMessages.length) return;
    client.resume(id);
    for (const stored of storedMessages) addMessage({ role: stored.role, text: stored.content });
  } catch { localStorage.removeItem(conversationKey); }
}

function memoryCard(memory) {
  const article = document.createElement("article"); article.className = "memory-card"; article.dataset.memoryId = memory.id;
  const heading = document.createElement("div"); heading.className = "memory-card-heading";
  const tags = document.createElement("div"); tags.className = "memory-tags";
  for (const label of [memory.category.replaceAll("_", " "), memory.scope, memory.projectId].filter(Boolean)) { const tag = document.createElement("span"); tag.textContent = label; tags.append(tag); }
  const actions = document.createElement("div"); actions.className = "memory-actions";
  const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.dataset.action = "edit";
  const forget = document.createElement("button"); forget.type = "button"; forget.textContent = "Forget"; forget.dataset.action = "forget";
  actions.append(edit, forget); heading.append(tags, actions);
  const content = document.createElement("p"); content.textContent = memory.content;
  const meta = document.createElement("small"); meta.textContent = `${memory.privacy} · ${memory.provenance}`;
  article.append(heading, content, meta); return article;
}

async function loadMemoryWorkspace() {
  const list = document.querySelector("#memoryList"); const error = document.querySelector("#memoryError");
  list.innerHTML = '<div class="memory-loading">Loading private memory…</div>'; error.hidden = true;
  try {
    const category = document.querySelector("#memoryFilter").value;
    const [{ owner }, { memories: loaded }] = await Promise.all([ownerMemoryClient.profile(), ownerMemoryClient.list(category)]);
    currentProfile = owner; memoryRecords = loaded;
    document.querySelector("#ownerProfileHeading").textContent = owner.fullName;
    document.querySelector(".arabic-name").textContent = owner.arabicName || "";
    const form = document.querySelector("#profileForm"); form.elements.preferredName.value = owner.preferredName || "";
    form.elements.currentLocation.value = owner.facts?.currentLocation || "";
    form.elements.communication.value = owner.preferences?.communication || "";
    list.replaceChildren(...loaded.map(memoryCard));
    if (!loaded.length) list.innerHTML = '<div class="empty-memory">No memories in this category.</div>';
  } catch (cause) { list.replaceChildren(); error.textContent = cause.message; error.hidden = false; }
}

document.querySelector("#profileForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const status = document.querySelector("#profileStatus"); status.textContent = "Saving…";
  try {
    const { owner } = await ownerMemoryClient.updateProfile({ preferredName: form.elements.preferredName.value.trim(), facts: { ...(currentProfile.facts || {}), currentLocation: form.elements.currentLocation.value.trim() }, preferences: { ...(currentProfile.preferences || {}), communication: form.elements.communication.value.trim() } });
    currentProfile = owner; status.textContent = "Profile saved";
  } catch (cause) { status.textContent = cause.message; }
});

const memoryDialog = document.querySelector("#memoryDialog"); const memoryForm = document.querySelector("#memoryForm");
function closeMemoryDialog() { memoryDialog.hidden = true; }
function openMemoryDialog(memory) {
  memoryForm.reset(); memoryForm.elements.memoryId.value = memory?.id || ""; memoryForm.elements.content.value = memory?.content || ""; memoryForm.elements.category.value = memory?.category || "preference"; memoryForm.elements.scope.value = memory?.scope || "global"; memoryForm.elements.projectId.value = memory?.projectId || "nova-brain";
  document.querySelector("#memoryDialogTitle").textContent = memory ? "Edit memory" : "Add memory"; document.querySelector("#projectField").hidden = memoryForm.elements.scope.value !== "project";
  memoryDialog.hidden = false;
}
document.querySelector("#addMemoryButton").addEventListener("click", () => openMemoryDialog());
document.querySelectorAll("[data-close-memory]").forEach((button) => button.addEventListener("click", closeMemoryDialog));
memoryForm.elements.scope.addEventListener("change", () => { document.querySelector("#projectField").hidden = memoryForm.elements.scope.value !== "project"; });
memoryForm.addEventListener("submit", async (event) => {
  event.preventDefault(); const id = memoryForm.elements.memoryId.value; const scope = memoryForm.elements.scope.value;
  const input = { content: memoryForm.elements.content.value.trim(), category: memoryForm.elements.category.value, scope, privacy: "private", sensitivity: "normal", ...(scope === "project" ? { projectId: memoryForm.elements.projectId.value } : id ? { projectId: null } : {}) };
  const save = document.querySelector("#saveMemoryButton"); save.disabled = true;
  try { if (id) await ownerMemoryClient.update(id, input); else await ownerMemoryClient.create(input); closeMemoryDialog(); await loadMemoryWorkspace(); }
  catch (cause) { document.querySelector("#memoryError").textContent = cause.message; document.querySelector("#memoryError").hidden = false; }
  finally { save.disabled = false; }
});

document.querySelector("#memoryList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const card = button.closest("[data-memory-id]"); const memory = memoryRecords.find((item) => item.id === card.dataset.memoryId); if (!memory) return;
  if (button.dataset.action === "edit") openMemoryDialog(memory);
  if (button.dataset.action === "forget" && confirm("Forget this memory? This removes it from Nova's active memory.")) { await ownerMemoryClient.forget(memory.id); await loadMemoryWorkspace(); }
});
document.querySelector("#memoryFilter").addEventListener("change", loadMemoryWorkspace);

await restoreConversation();
showSection(location.hash === "#memory" ? "memory" : "chat");
