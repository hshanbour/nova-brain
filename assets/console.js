import { createNovaClient } from "./api-client.js";

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
  client.reset(); messages.querySelectorAll(".message").forEach((message) => message.remove()); welcome.hidden = false;
  requestError.hidden = true; input.value = ""; resizeInput(); input.focus();
});
fetch("/api/health").then((response) => response.ok ? response.json() : Promise.reject()).then((health) => { providerStatus.textContent = `${health.provider} provider · Ready`; }).catch(() => { providerStatus.textContent = "Status unavailable"; });
resizeInput();
