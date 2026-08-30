import { createNovaClient } from "./api-client.js";
import { ownerMemoryClient } from "./memory-client.js";
import { selectWorkspace } from "./workspace-navigation.js";
import { conversationTitle, createConversationHistory } from "./conversation-history.js";
import { createVoiceInput } from "./voice-input.js";
import { MICROPHONE_LANGUAGES } from "./voice-input.js";
import { createVoiceOutput, hasLanguageVoice } from "./voice-output.js";
import { createVoiceMode } from "./voice-mode.js";
import { initialiseVoiceBenchmark } from "./voice-benchmark.js";

const client = createNovaClient();
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const messages = document.querySelector("#messages");
const welcome = document.querySelector("#welcomeState");
const sendButton = document.querySelector("#sendButton");
const requestError = document.querySelector("#requestError");
const template = document.querySelector("#messageTemplate");
const providerStatus = document.querySelector("#providerStatus");
const voiceBenchmark = initialiseVoiceBenchmark({ document, navigator, MediaRecorder: window.MediaRecorder, URL });
let pending = false;
let currentProfile;
let memoryRecords = [];
const conversationKey = "nova.activeConversationId";
const conversationHistory = createConversationHistory({ client, api: ownerMemoryClient, key: conversationKey });
const recentsDrawer = document.querySelector("#recentsDrawer");
let voiceMessageSequence = 0;
let voiceMode;
function showVoiceDiagnostic(message) { const target=document.querySelector("#voiceDiagnostic");if(target)target.textContent=String(message||"").slice(0,240); }
const voiceOutput = createVoiceOutput({
  synthesis: window.speechSynthesis,
  Utterance: window.SpeechSynthesisUtterance,
  storage: localStorage,
  onState({ speaking, starting, id }) {
    document.querySelectorAll(".speak-response").forEach((button) => {
      const active = (speaking || starting) && button.dataset.voiceId === String(id);
      button.classList.toggle("speaking", active); button.textContent = active ? "■" : "▶";
      button.setAttribute("aria-label", active ? "Stop speaking" : "Speak response");
      button.title = active ? "Stop speaking" : "Speak response";
    });
  },
  onVoices: populateVoiceChoices,
  onDiagnostic: showVoiceDiagnostic
});
function stopVoiceActivity() { if(voiceMode?.isActive())voiceMode.end();else voiceOutput.stop(); }

function resizeInput() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 176)}px`; }
function scrollToLatest() { messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" }); }
function timeLabel() { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date()); }
function updatedLabel(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Saved conversation" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date); }

function clearConversation() {
  messages.querySelectorAll(".message").forEach((message) => message.remove()); welcome.hidden = false;
  requestError.hidden = true; input.value = ""; resizeInput();
}

function recentItems(conversations) {
  const activeId = client.conversationId;
  return conversations.map((conversation) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "recent-conversation"; button.dataset.conversationId = conversation.id;
    if (conversation.id === activeId) { button.classList.add("active"); button.setAttribute("aria-current", "true"); }
    const title = document.createElement("strong"); title.textContent = conversationTitle(conversation.title); title.title = conversation.title || "Untitled conversation";
    const date = document.createElement("small"); date.textContent = updatedLabel(conversation.updatedAt);
    button.append(title, date); return button;
  });
}

function renderRecents(conversations) {
  for (const list of [document.querySelector("#recentsList"), document.querySelector("#mobileRecentsList")]) {
    if (!conversations.length) list.innerHTML = '<p class="recents-state">No previous conversations yet.</p>';
    else list.replaceChildren(...recentItems(conversations));
  }
}

function renderRecentsState(message, error = false) {
  for (const list of [document.querySelector("#recentsList"), document.querySelector("#mobileRecentsList")]) list.innerHTML = `<p class="recents-state${error ? " error" : ""}">${message}</p>`;
}

async function refreshRecents() {
  try { renderRecents(await conversationHistory.refresh()); }
  catch { renderRecentsState("Conversation history is unavailable. Chat still works.", true); }
}

async function selectConversation(id) {
  stopVoiceActivity();
  renderRecentsState("Loading conversation…"); requestError.hidden = true;
  try {
    const storedMessages = await conversationHistory.select(id);
    clearConversation();
    for (const stored of storedMessages) addMessage({ role: stored.role, text: stored.content });
    if (!storedMessages.length) welcome.hidden = false;
    recentsDrawer.hidden = true; await refreshRecents(); input.focus();
  } catch (cause) {
    requestError.textContent = cause.message || "Conversation history could not be loaded."; requestError.hidden = false;
    await refreshRecents();
  }
}

function addMessage({ role, text, metadata, autoSpeak = false }) {
  welcome.hidden = true;
  const node = template.content.firstElementChild.cloneNode(true);
  const isNova = role === "assistant";
  node.classList.add(isNova ? "nova-message" : "owner-message");
  node.querySelector(".avatar").textContent = isNova ? "N" : "Y";
  node.querySelector("strong").textContent = isNova ? "Nova" : "You";
  node.querySelector("time").textContent = timeLabel();
  node.querySelector(".message-body").textContent = text;
  if (isNova && voiceOutput.supported) {
    const speak = node.querySelector(".speak-response"); const voiceId = `message-${++voiceMessageSequence}`;
    speak.hidden = false; speak.dataset.voiceId = voiceId; speak.dataset.speechText = text;
    if (autoSpeak && voiceOutput.getAutoSpeak()) queueMicrotask(() => voiceOutput.speak(text, { id: voiceId }));
  }
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

async function sendMessage(message,{autoSpeakResponse=true,throwOnError=false}={}) {
  requestError.hidden = true; addMessage({ role: "user", text: message }); addThinking(); setPending(true);
  try {
    const result = await client.send(message);
    localStorage.setItem(conversationKey, result.conversationId);
    document.querySelector("#thinkingMessage")?.remove();
    addMessage({ role: "assistant", text: result.message, metadata: result, autoSpeak: autoSpeakResponse });
    providerStatus.textContent = `${result.provider || "Agent"} provider · Ready`;
    await refreshRecents(); return result;
  } catch (error) {
    document.querySelector("#thinkingMessage")?.remove(); requestError.textContent = error.message; requestError.hidden = false;
    if(throwOnError)throw error;
  } finally { setPending(false); input.focus(); }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault(); const message = input.value.trim(); if (!message || pending) return;
  stopVoiceActivity(); input.value = ""; resizeInput(); sendMessage(message);
});
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } });
document.querySelector("#newChatButton").addEventListener("click", () => {
  stopVoiceActivity(); conversationHistory.startNew(); clearConversation(); renderRecents(conversationHistory.conversations); input.focus();
});
document.querySelector("#refreshRecentsButton").addEventListener("click", refreshRecents);
document.querySelector("#historyButton").addEventListener("click", () => { recentsDrawer.hidden = false; refreshRecents(); });
document.querySelector("#closeRecentsButton").addEventListener("click", () => { recentsDrawer.hidden = true; });
recentsDrawer.addEventListener("click", (event) => { if (event.target === recentsDrawer) recentsDrawer.hidden = true; });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !recentsDrawer.hidden) recentsDrawer.hidden = true; });
for (const list of document.querySelectorAll(".recents-list")) list.addEventListener("click", (event) => { const button = event.target.closest("[data-conversation-id]"); if (button) selectConversation(button.dataset.conversationId); });
fetch("/api/health").then((response) => response.ok ? response.json() : Promise.reject()).then((health) => { providerStatus.textContent = `${health.provider} provider · Ready`; }).catch(() => { providerStatus.textContent = "Status unavailable"; });
resizeInput();

function showSection(name) {
  stopVoiceActivity();
  const selected = selectWorkspace({ workspaces: document.querySelectorAll("main.workspace"), links: document.querySelectorAll("[data-section]"), name });
  if (selected === "memory") loadMemoryWorkspace();
  if (["projects","activity","tools","approvals"].includes(selected)) loadDashboard(selected);
  if (selected === "voice-benchmark") voiceBenchmark.refresh().catch(() => {});
}

document.querySelectorAll("[data-section]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); const name = link.dataset.section; history.replaceState(null, "", `#${name}`); showSection(name); }));

async function restoreConversation() {
  try {
    const restored = await conversationHistory.restore(); if (!restored) return;
    for (const stored of restored.messages) addMessage({ role: stored.role, text: stored.content });
  } catch { requestError.textContent = "The previous conversation could not be restored. You can start a new chat."; requestError.hidden = false; }
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

function dashboardCard(title, subtitle, body, badges = []) {
  const article=document.createElement("article");article.className="dashboard-card";
  const heading=document.createElement("div");heading.className="dashboard-card-heading";const copy=document.createElement("div");const name=document.createElement("h2");name.textContent=title;const detail=document.createElement("small");detail.textContent=subtitle||"";copy.append(name,detail);const tags=document.createElement("div");tags.className="dashboard-tags";for(const badge of badges.filter(Boolean)){const tag=document.createElement("span");tag.textContent=badge;tags.append(tag);}heading.append(copy,tags);const content=document.createElement("p");content.textContent=body||"";article.append(heading,content);return article;
}

async function loadDashboard(section) {
  const list=document.querySelector(`#${section}List`);list.innerHTML=`<p class="dashboard-state">Loading ${section}…</p>`;
  try {
    if(section==="projects") { const {projects}=await ownerMemoryClient.projects(); list.replaceChildren(...projects.map((project)=>dashboardCard(project.name,project.id,project.description,[`${project.memories.length} memories`,`${project.runs.length} runs`]))); }
    if(section==="activity") { const {activity}=await ownerMemoryClient.activity(); list.replaceChildren(...activity.map((event)=>dashboardCard(event.action,event.createdAt,event.summary,[event.status,event.tool,event.projectId]))); }
    if(section==="tools") { const {tools}=await ownerMemoryClient.tools(); list.replaceChildren(...tools.map((tool)=>dashboardCard(tool.name,tool.description,tool.available===false?"Configuration required or adapter unavailable.":"Connected to Nova's runtime registry.",[tool.category,tool.riskLevel,tool.capability,tool.available===false?"Unavailable":"Ready"]))); }
    if(section==="approvals") { const {approvals}=await ownerMemoryClient.approvals(); list.replaceChildren(...approvals.map((approval)=>{const card=dashboardCard(approval.tool,approval.reason,JSON.stringify(approval.arguments),[approval.riskLevel,approval.status,approval.projectId]);if(approval.status==="pending"){const actions=document.createElement("div");actions.className="approval-actions";for(const decision of ["approved","rejected"]){const button=document.createElement("button");button.type="button";button.className=decision==="approved"?"send-button":"secondary-button";button.textContent=decision==="approved"?"Approve":"Reject";button.addEventListener("click",async()=>{button.disabled=true;try{await ownerMemoryClient.decideApproval(approval.id,decision);await loadDashboard("approvals");}catch(cause){list.innerHTML=`<p class="dashboard-state error">${cause.message}</p>`;}});actions.append(button);}card.append(actions);}return card;})); }
    if(!list.children.length)list.innerHTML=`<p class="dashboard-state">No ${section} yet.</p>`;
  } catch(cause) { list.innerHTML=`<p class="dashboard-state error">${cause.message}</p>`; }
}

messages.addEventListener("click",(event)=>{const button=event.target.closest(".speak-response");if(!button)return;if(voiceOutput.activeId()===button.dataset.voiceId)voiceOutput.stop();else voiceOutput.speak(button.dataset.speechText,{id:button.dataset.voiceId});});

const voiceSettingsDialog=document.querySelector("#voiceSettingsDialog");
const microphoneLanguage=document.querySelector("#microphoneLanguage");
const voiceModeLanguage=document.querySelector("#voiceModeLanguage");
const preferredVoice=document.querySelector("#preferredVoice");
const autoSpeak=document.querySelector("#autoSpeak");
function populateVoiceChoices(voices=voiceOutput.getVoices()) {
  const saved=voiceOutput.getPreferredVoice(); preferredVoice.replaceChildren();
  const automatic=document.createElement("option");automatic.value="";automatic.textContent="Automatic language match";preferredVoice.append(automatic);
  for(const item of voices){const option=document.createElement("option");option.value=item.voiceURI||item.name;option.textContent=`${item.name} — ${item.lang}`;preferredVoice.append(option);}
  preferredVoice.value=[...preferredVoice.options].some(({value})=>value===saved)?saved:"";
  document.querySelector("#voiceOutputSupport").textContent=!voiceOutput.supported?"Speech output is unavailable in this browser.":hasLanguageVoice(voices,"ar")?"Arabic browser voice installed. Nova will match Arabic responses to an ar-* voice.":"No Arabic browser voice is installed. Arabic responses will use a fallback voice.";
}
for(const target of [microphoneLanguage,voiceModeLanguage])for(const [label,value] of MICROPHONE_LANGUAGES){const option=document.createElement("option");option.value=value;option.textContent=`${label} · ${value}`;target.append(option);}
autoSpeak.checked=voiceOutput.getAutoSpeak();
document.querySelector("#voiceSettingsButton").addEventListener("click",()=>{voiceOutput.refreshVoices();voiceSettingsDialog.hidden=false;});
document.querySelectorAll("[data-close-voice-settings]").forEach((button)=>button.addEventListener("click",()=>{voiceSettingsDialog.hidden=true;}));
preferredVoice.addEventListener("change",()=>voiceOutput.setPreferredVoice(preferredVoice.value));
autoSpeak.addEventListener("change",()=>voiceOutput.setAutoSpeak(autoSpeak.checked));
document.querySelector("#testVoiceButton").addEventListener("click",()=>{showVoiceDiagnostic("Starting local browser voice test…");voiceOutput.speak("Nova voice test.",{id:"test-voice",onComplete(){showVoiceDiagnostic("Test Voice completed. Did you hear it?");},onError(reason){showVoiceDiagnostic(`Test Voice failed: ${reason}. Choose another voice and retry.`);}});});

const voiceButton=document.querySelector("#voiceButton");let voiceListening=false;
const voice=createVoiceInput({SpeechRecognition:window.SpeechRecognition||window.webkitSpeechRecognition,storage:localStorage,onText(text){input.value=text;resizeInput();},onFinal(text){voiceMode?.acceptFinal(text);},onEnd(result){voiceMode?.recognitionEnded(result);},onState(state){voiceListening=state==="listening";voiceButton.classList.toggle("listening",voiceListening);if(!voiceMode?.isActive())voiceButton.setAttribute("aria-label",voiceListening?"Stop voice input":"Start voice input");},onError(error){if(voiceMode?.isActive()){voiceMode.recognitionError(error);return;}requestError.textContent=error.message;requestError.hidden=false;}});
function setMicrophoneLanguage(value){voice.setLanguage(value);microphoneLanguage.value=voice.getLanguage();voiceModeLanguage.value=voice.getLanguage();}
setMicrophoneLanguage(voice.getLanguage());
microphoneLanguage.addEventListener("change",()=>setMicrophoneLanguage(microphoneLanguage.value));
voiceModeLanguage.addEventListener("change",()=>setMicrophoneLanguage(voiceModeLanguage.value));
document.querySelector("#voiceInputSupport").textContent=voice.supported?"Browser recognition uses this primary locale for every listen and restart; it does not reliably auto-detect Arabic and English together.":"Speech recognition is unavailable in this browser.";
if(!voice.supported){voiceButton.classList.add("unsupported");voiceButton.title="Voice input is not supported in this browser";}
const voiceModeButton=document.querySelector("#voiceModeButton");const voiceModeStatus=document.querySelector("#voiceModeStatus");
const voiceModeLabels={idle:"Voice idle",listening:"Listening…",thinking:"Understanding…",speaking:"Nova speaking…",retrying:"No speech · retrying…",error:"Voice needs attention"};
voiceMode=createVoiceMode({startRecognition:()=>voice.start(),stopRecognition:()=>voice.stop(),stopSpeech:()=>voiceOutput.stop(),sendTurn:(text)=>{input.value="";resizeInput();return sendMessage(text,{autoSpeakResponse:false,throwOnError:true});},speakResponse:(text,options)=>voiceOutput.speak(text,options),onState({active,state}){voiceModeStatus.textContent=`${voiceModeLabels[state]||state}${state==="listening"?` · ${voice.getLanguage()}`:""}`;voiceModeButton.classList.toggle("active",active);voiceModeButton.setAttribute("aria-label",active?"End Voice":"Start Voice");voiceModeButton.querySelector("span:last-child").textContent=active?"End Voice":"Start Voice";voiceModeLanguage.disabled=active&&state==="thinking";voiceButton.setAttribute("aria-label",active&&state==="speaking"?"Interrupt Nova and speak":voiceListening?"Stop voice input":"Start voice input");},onNotice(message){voiceModeStatus.textContent=message;},onError(message){requestError.textContent=message;requestError.hidden=false;}});
voiceModeButton.addEventListener("click",()=>{requestError.hidden=true;if(voiceMode.isActive())voiceMode.end();else if(!voice.supported||!voiceOutput.supported){requestError.textContent="Conversational Voice requires browser speech recognition and speech output.";requestError.hidden=false;}else voiceMode.start();});
voiceButton.addEventListener("click",()=>{requestError.hidden=true;if(voiceMode.isActive()){if(voiceMode.getState()==="speaking")voiceMode.interrupt();return;}if(voiceListening)voice.stop();else{voiceOutput.stop();voice.start();}});

await restoreConversation();
await refreshRecents();
showSection(["#projects","#activity","#memory","#tools","#approvals","#voice-benchmark"].includes(location.hash)?location.hash.slice(1):"chat");
