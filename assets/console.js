import { createNovaClient, durableTaskRecordsFromMessages } from "./api-client.js";
import { ownerMemoryClient } from "./memory-client.js";
import { selectWorkspace } from "./workspace-navigation.js";
import { conversationTitle, createConversationHistory } from "./conversation-history.js";
import { MICROPHONE_LANGUAGES, createComposerVoiceControl } from "./voice-input.js";
import { createVoiceOutput, hasLanguageVoice } from "./voice-output.js";
import { createVoiceV2Client } from "./voice-v2-client.js";
import { createAudioPlayback, createMediaVoiceCapture } from "./voice-capture.js";
import { createVoiceV2 } from "./voice-v2.js";
import { initialiseVoiceBenchmark } from "./voice-benchmark.js";
import { initialiseSpeakerEnrollment } from "./speaker-enrollment.js";
import { initialiseSpeakerFamiliarity } from "./speaker-familiarity.js";

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
initialiseSpeakerEnrollment({ document, navigator, MediaRecorder: window.MediaRecorder });
const speakerFamiliarity=initialiseSpeakerFamiliarity({document});
fetch("/api/auth/probe", { method: "POST", credentials: "same-origin" }).catch(() => {});
fetch("/api/speakers/enroll", { method: "HEAD", credentials: "same-origin" }).catch(() => {});
let pending = false;
let activeSendController = null;
let currentProfile;
let memoryRecords = [];
const conversationKey = "nova.activeConversationId";
const conversationHistory = createConversationHistory({ client, api: ownerMemoryClient, key: conversationKey });
const recentsDrawer = document.querySelector("#recentsDrawer");
let voiceMessageSequence = 0;
let voiceV2;
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
function stopVoiceActivity() { if(voiceV2?.isActive())voiceV2.end();else voiceOutput.stop(); }

function resizeInput() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 176)}px`; }
function scrollToLatest() { messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" }); }
function timeLabel() { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date()); }
function updatedLabel(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Saved conversation" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date); }

const liveActivityStorageKey="nova.liveActivity.v1";
const liveActivityRecords=new Map();
const terminalTaskStates=new Set(["completed","failed","cancelled","expired","blocked"]);
const taskStatusLabels=Object.freeze({queued:"Queued",planning:"Planning",running:"Working on it…",waiting:"Waiting",waiting_for_worker:"Waiting for worker",waiting_for_approval:"Waiting for approval",retrying:"Retrying",blocked:"Blocked",completed:"Completed",failed:"Failed",cancelled:"Cancelled",expired:"Expired",paused:"Paused"});
const taskErrorLabels=Object.freeze({implementation_scope_required:"Implementation scope needs attention.",structured_scope_unresolved:"A safe implementation scope could not be resolved.",structured_scope_recovery_exhausted:"Scope recovery was exhausted safely.",implementation_prerequisite_unresolved:"An implementation prerequisite is unresolved.",max_runtime_reached:"The bounded runtime expired.",test_failed:"Tests failed.",repair_limit_reached:"The bounded repair limit was reached.",review_rejected:"Review found an issue that must be resolved."});
const approvalToolLabels=Object.freeze({git_push:"Push to GitHub",preview_deploy:"Deploy Preview",self_development_protected_change:"Protected change",coding_job_create:"Start approved Codex coding job"});
function readLiveActivityRecords(){try{const value=JSON.parse(localStorage.getItem(liveActivityStorageKey)||"[]");return Array.isArray(value)?value.filter(item=>/^(?:selfdev|orchestration|coding)_[a-f0-9]{32}$/.test(item?.taskId||"")&&typeof item.conversationId==="string").slice(-20):[];}catch{return[];}}
function persistLiveActivityRecords(){try{const retained=readLiveActivityRecords().filter(item=>!liveActivityRecords.has(item.taskId)),current=[...liveActivityRecords.values()].map(({taskId,conversationId,startedAt,completedAt})=>({taskId,conversationId,startedAt,completedAt:completedAt||null}));localStorage.setItem(liveActivityStorageKey,JSON.stringify([...retained,...current].slice(-20)));}catch{}}
function elapsedLabel(startedAt,endedAt,live=true){const start=new Date(startedAt).valueOf(),end=endedAt?new Date(endedAt).valueOf():live?Date.now():Number.NaN;if(!Number.isFinite(start)||!Number.isFinite(end))return"";const seconds=Math.max(0,Math.floor((end-start)/1000)),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);return hours?`${hours}h ${minutes%60}m`:minutes?`${minutes}m ${seconds%60}s`:`${seconds}s`;}
function safeProgressLabel(task,activity=[]){
  if(task.status==="waiting_for_approval")return"Waiting for your approval";
  if(task.status==="blocked"||task.status==="paused"||terminalTaskStates.has(task.status))return taskStatusLabels[task.status]||"Working on it…";
  const action=activity.find(item=>typeof item?.action==="string")?.action||"",phase=String(task.currentPhase||"");
  if(/deploy/.test(action+phase))return"Deploying Preview";
  if(/push/.test(action+phase))return"Pushing to GitHub";
  if(/review/.test(action+phase))return"Reviewing changes";
  if(/test/.test(action+phase))return"Running tests";
  if(/apply|patch|edit|mutat/.test(action+phase))return"Editing files";
  if(/plan|preservation/.test(action+phase))return"Planning implementation";
  if(/read/.test(action+phase))return"Reading files";
  if(/search|discover|scope/.test(action+phase))return"Searching code";
  return taskStatusLabels[task.status]||"Working on it…";
}
function createLiveActivityNode(taskId){
  const node=document.createElement("article");node.className="message nova-message live-activity-message";node.dataset.taskId=taskId;
  const avatar=document.createElement("div");avatar.className="avatar";avatar.textContent="N";
  const content=document.createElement("div");content.className="message-content";
  const heading=document.createElement("div");heading.className="message-heading";const name=document.createElement("strong");name.textContent="Nova";const time=document.createElement("time");time.textContent=timeLabel();heading.append(name,time);
  const card=document.createElement("section");card.className="live-activity-card";card.setAttribute("aria-live","polite");card.setAttribute("aria-label","Nova task activity");
  content.append(heading,card);node.append(avatar,content);messages.append(node);scrollToLatest();return node;
}
function renderLiveActivity(record,task,activity=[],approvals=[]){
  const card=record.node.querySelector(".live-activity-card"),terminal=terminalTaskStates.has(task.status),endedAt=terminal?(task.completedAt||task.updatedAt||record.completedAt||null):null;
  record.completedAt=endedAt;record.lastVersion=task.stateVersion;record.status=task.status;record.startedAt=record.startedAt||task.createdAt||new Date().toISOString();
  card.dataset.state=task.status;card.replaceChildren();
  const top=document.createElement("div");top.className="live-activity-top";const pulse=document.createElement("span");pulse.className="live-activity-pulse";pulse.hidden=terminal||task.status==="waiting_for_approval";const copy=document.createElement("div");const title=document.createElement("strong");title.textContent=taskStatusLabels[task.status]||"Working on it…";const progress=document.createElement("span");progress.className="live-activity-progress";progress.textContent=safeProgressLabel(task,activity);copy.append(title,progress);const elapsed=document.createElement("time");elapsed.className="live-activity-elapsed";elapsed.textContent=elapsedLabel(record.startedAt,endedAt,!terminal);top.append(pulse,copy,elapsed);card.append(top);
  if(task.status==="failed"||task.status==="blocked"||task.status==="expired"){const issue=document.createElement("p");issue.className="live-activity-issue";issue.textContent=taskErrorLabels[task.errorCode]||"Nova stopped safely and preserved the task history.";card.append(issue);}
  const controls=document.createElement("div");controls.className="live-activity-actions";
  const matchingApprovals=approvals.filter(item=>item?.status==="pending"&&(item?.runId===task.id||item?.arguments?.taskId===task.id||item?.arguments?.parentTaskId===task.id));
  for(const approval of matchingApprovals){const label=document.createElement("span");label.className="live-activity-approval";label.textContent=approvalToolLabels[approval.tool]||"Approval required";controls.append(label);for(const decision of["approved","rejected"]){const button=document.createElement("button");button.type="button";button.className=decision==="approved"?"live-activity-primary":"live-activity-secondary";button.textContent=decision==="approved"?"Approve":"Reject";button.addEventListener("click",async()=>{button.disabled=true;try{const result=await ownerMemoryClient.decideApproval(approval.id,decision),delegatedId=result?.execution?.task?.id;if(decision==="approved"&&/^coding_[a-f0-9]{32}$/.test(delegatedId||"")){liveActivityRecords.delete(record.taskId);record.taskId=delegatedId;record.node.dataset.taskId=delegatedId;liveActivityRecords.set(delegatedId,record);persistLiveActivityRecords();}await refreshLiveActivity(record);}catch(cause){showLiveActivityError(record,cause.message);await refreshLiveActivity(record).catch(()=>{});}});controls.append(button);}}
  const cancellable=!terminal&&!task.leaseOwner&&!task.leaseToken&&!["running","waiting_for_approval"].includes(task.status);
  if(!terminal){const stop=document.createElement("button");stop.type="button";stop.className="live-activity-secondary";stop.textContent="Stop";stop.disabled=!cancellable;stop.title=cancellable?"Cancel this durable task":"The current action must finish before this task can be stopped safely.";stop.addEventListener("click",async()=>{stop.disabled=true;try{await ownerMemoryClient.cancelTask(task.id);await refreshLiveActivity(record);}catch(cause){showLiveActivityError(record,cause.message);}});controls.append(stop);}
  if(controls.children.length)card.append(controls);persistLiveActivityRecords();scrollToLatest();
}
function showLiveActivityError(record,message){let error=record.node.querySelector(".live-activity-error");if(!error){error=document.createElement("p");error.className="live-activity-error";record.node.querySelector(".live-activity-card").append(error);}error.textContent=String(message||"Live task status is temporarily unavailable.").slice(0,180);}
async function refreshLiveActivity(record){
  clearTimeout(record.timer);
  try{
    const detail=await ownerMemoryClient.task(record.taskId),task=detail.task;if(!task||task.id!==record.taskId)throw new Error("Task status is unavailable.");
    const [activityResult,approvalResult]=await Promise.all([ownerMemoryClient.taskActivity(record.taskId).catch(()=>({activity:[]})),task.status==="waiting_for_approval"?ownerMemoryClient.approvals().catch(()=>({approvals:[]})):Promise.resolve({approvals:[]})]);
    renderLiveActivity(record,task,activityResult.activity||[],approvalResult.approvals||[]);
    if(!terminalTaskStates.has(task.status))record.timer=setTimeout(()=>refreshLiveActivity(record),4000);
  }catch(cause){showLiveActivityError(record,cause.message);record.timer=setTimeout(()=>refreshLiveActivity(record),6000);}
}
function ensureLiveActivity(durableTask,{startedAt=new Date().toISOString()}={}){
  if(!/^(?:selfdev|orchestration|coding)_[a-f0-9]{32}$/.test(durableTask?.id||""))return null;
  let record=liveActivityRecords.get(durableTask.id);if(record)return record;
  record={taskId:durableTask.id,conversationId:client.conversationId||"",startedAt,node:createLiveActivityNode(durableTask.id),timer:null,completedAt:null};liveActivityRecords.set(record.taskId,record);persistLiveActivityRecords();void refreshLiveActivity(record);return record;
}
function stopLiveActivityPolling(){for(const record of liveActivityRecords.values())clearTimeout(record.timer);liveActivityRecords.clear();}
function restoreLiveActivities(storedMessages=[]){
  const known=new Map(readLiveActivityRecords().filter(item=>item.conversationId===client.conversationId).map(item=>[item.taskId,item]));
  for(const item of durableTaskRecordsFromMessages(storedMessages,client.conversationId)){if(!known.has(item.taskId))known.set(item.taskId,{...item,startedAt:item.startedAt||new Date().toISOString()});}
  for(const stored of known.values()){if(liveActivityRecords.has(stored.taskId))continue;const record={...stored,node:createLiveActivityNode(stored.taskId),timer:null};liveActivityRecords.set(stored.taskId,record);void refreshLiveActivity(record);}
  persistLiveActivityRecords();
}

function clearConversation() {
  stopLiveActivityPolling();
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
    restoreLiveActivities(storedMessages);
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
  pending = value; input.disabled = value; sendButton.disabled = false;
  sendButton.querySelector("span:first-child").textContent = value ? "Stop" : "Send";
}

async function sendMessage(message,{autoSpeakResponse=true,throwOnError=false,signal,prepareAssistant,context}={}) {
  requestError.hidden = true; addMessage({ role: "user", text: message }); addThinking(); setPending(true);
  try {
    const result = await client.send(message,{signal,context});
    localStorage.setItem(conversationKey, result.conversationId);
    let preparedAssistant; let preparationError;
    if (prepareAssistant) {
      try { preparedAssistant = await prepareAssistant(result.message, result); }
      catch (error) { preparationError = error; }
    }
    document.querySelector("#thinkingMessage")?.remove();
    if(result.durableTask?.id)ensureLiveActivity(result.durableTask);else addMessage({ role: "assistant", text: result.message, metadata: result, autoSpeak: autoSpeakResponse });
    providerStatus.textContent = `${result.provider || "Agent"} provider · Ready`;
    void refreshRecents(); return { ...result, preparedAssistant, preparationError };
  } catch (error) {
    document.querySelector("#thinkingMessage")?.remove();
    if(error?.name!=="AbortError"){requestError.textContent = error.message; requestError.hidden = false;}
    if(throwOnError)throw error;
  } finally { setPending(false); input.focus(); }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pending) { activeSendController?.abort(); return; }
  const message = input.value.trim(); if (!message) return;
  voiceControl.commit(); stopVoiceActivity(); input.value = ""; resizeInput();
  const controller = new AbortController(); activeSendController = controller;
  sendMessage(message,{signal:controller.signal}).finally(()=>{if(activeSendController===controller)activeSendController=null;});
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
    restoreLiveActivities(restored.messages);
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
const preferredVoice=document.querySelector("#preferredVoice");
const autoSpeak=document.querySelector("#autoSpeak");
function populateVoiceChoices(voices=voiceOutput.getVoices()) {
  const saved=voiceOutput.getPreferredVoice(); preferredVoice.replaceChildren();
  const automatic=document.createElement("option");automatic.value="";automatic.textContent="Automatic language match";preferredVoice.append(automatic);
  for(const item of voices){const option=document.createElement("option");option.value=item.voiceURI||item.name;option.textContent=`${item.name} — ${item.lang}`;preferredVoice.append(option);}
  preferredVoice.value=[...preferredVoice.options].some(({value})=>value===saved)?saved:"";
  document.querySelector("#voiceOutputSupport").textContent=!voiceOutput.supported?"Speech output is unavailable in this browser.":hasLanguageVoice(voices,"ar")?"Arabic browser voice installed. Nova will match Arabic responses to an ar-* voice.":"No Arabic browser voice is installed. Arabic responses will use a fallback voice.";
}
autoSpeak.checked=voiceOutput.getAutoSpeak();
document.querySelector("#voiceSettingsButton").addEventListener("click",()=>{voiceOutput.refreshVoices();voiceSettingsDialog.hidden=false;});
document.querySelectorAll("[data-close-voice-settings]").forEach((button)=>button.addEventListener("click",()=>{voiceSettingsDialog.hidden=true;}));
preferredVoice.addEventListener("change",()=>voiceOutput.setPreferredVoice(preferredVoice.value));
autoSpeak.addEventListener("change",()=>voiceOutput.setAutoSpeak(autoSpeak.checked));
document.querySelector("#testVoiceButton").addEventListener("click",()=>{showVoiceDiagnostic("Starting local browser voice test…");voiceOutput.speak("Nova voice test.",{id:"test-voice",onComplete(){showVoiceDiagnostic("Test Voice completed. Did you hear it?");},onError(reason){showVoiceDiagnostic(`Test Voice failed: ${reason}. Choose another voice and retry.`);}});});

const voiceButton=document.querySelector("#voiceButton");
const voiceControl=createComposerVoiceControl({input,button:voiceButton,statusTarget:document.querySelector("#composerVoiceStatus"),errorTarget:document.querySelector("#composerVoiceError"),waveformTarget:document.querySelector("#composerVoiceWaveform"),resizeInput,dependencies:{SpeechRecognition:window.SpeechRecognition||window.webkitSpeechRecognition,storage:window.localStorage,mediaDevices:window.navigator?.mediaDevices,AudioContext:window.AudioContext||window.webkitAudioContext}});
function setMicrophoneLanguage(value){voiceControl.setLanguage(value);microphoneLanguage.value=voiceControl.getLanguage();}
for(const {label,code} of MICROPHONE_LANGUAGES){const option=document.createElement("option");option.value=code;option.textContent=`${label} · ${code}`;microphoneLanguage.append(option);}
setMicrophoneLanguage(voiceControl.getLanguage());
microphoneLanguage.addEventListener("change",()=>setMicrophoneLanguage(microphoneLanguage.value));
document.querySelector("#voiceInputSupport").textContent=voiceControl.controller.supported?"Browser recognition uses this primary locale for every listen and restart; it does not reliably auto-detect Arabic and English together.":"Speech recognition is unavailable in this browser.";
if(!voiceControl.controller.supported){voiceButton.classList.add("unsupported");voiceButton.title="Voice input is not supported in this browser";}
const voiceModeButton=document.querySelector("#voiceModeButton");const endVoiceButton=document.querySelector("#endVoiceButton");const voiceModeStatus=document.querySelector("#voiceModeStatus");
const voiceModeLabels={idle:"Voice idle",connecting:"Connecting microphone…",getting_ready:"Getting ready…",listening:"Voice ready · speak to Nova",barge_candidate:"Nova speaking… · speak to interrupt",barge_verifying:"Nova speaking… · speak to interrupt",paused_waiting_for_user:"Nova paused · say continue when ready",transcribing:"Nova heard you · processing…",thinking:"Nova thinking…",speaking:"Nova speaking… · speak to interrupt",interrupted:"Interrupted · getting ready…",retrying:"Voice ready · retrying quietly…",error:"Voice needs attention"};
const capture=createMediaVoiceCapture({mediaDevices:navigator.mediaDevices,MediaRecorder:window.MediaRecorder,AudioContext:window.AudioContext||window.webkitAudioContext});
const voiceClient=createVoiceV2Client({getFamiliarityConsent:()=>speakerFamiliarity.getConsentToken()});const playback=createAudioPlayback({Audio:window.Audio,URL});const interruptionPlayback=createAudioPlayback({Audio:window.Audio,URL});
voiceV2=createVoiceV2({capture,client:voiceClient,playback,interruptionPlayback,getConversationId:()=>client.conversationId,sendTurn:(text,{signal,prepareAssistant,speaker})=>{input.value="";resizeInput();return sendMessage(text,{autoSpeakResponse:false,throwOnError:true,signal,prepareAssistant,context:{voice:true,speaker}});},onTranscript(text){input.value=text;resizeInput();},onState({active,state}){voiceModeStatus.dataset.state=state;voiceModeStatus.textContent=voiceModeLabels[state]||state;voiceModeButton.classList.toggle("active",active);voiceModeButton.disabled=active;endVoiceButton.disabled=!active;voiceButton.disabled=active&&state!=="speaking";voiceButton.setAttribute("aria-label",active&&state==="speaking"?"Interrupt Nova and speak":"Dictate message");},onTiming(timing){console.info("[nova-voice-timing]",timing);void voiceClient.telemetry(timing).catch(()=>{});showVoiceDiagnostic(`Voice turn ${timing.turnId}: ${timing.stage}. ${Object.entries(timing.measurements).map(([name,value])=>`${name} ${value} ms`).join(" · ")}`);},onNotice(message){voiceModeStatus.textContent=message;},onError(message){requestError.textContent=message;requestError.hidden=false;}});
voiceModeButton.addEventListener("click",async()=>{requestError.hidden=true;if(!capture.supported){requestError.textContent="Start Voice requires MediaRecorder, microphone access, and Web Audio support.";requestError.hidden=false;return;}try{const readinessPromise=voiceClient.readiness();const startPromise=voiceV2.start();const [readiness,started]=await Promise.all([readinessPromise,startPromise]);if(!readiness.available){if(started)voiceV2.end();throw new Error("Voice V2 providers are not fully configured in this Preview.");}}catch(error){voiceV2.end();requestError.textContent=error.message||"Voice V2 could not start.";requestError.hidden=false;}});
endVoiceButton.addEventListener("click",()=>voiceV2.end());
voiceButton.addEventListener("click",(event)=>{if(!voiceV2.isActive())return;event.stopImmediatePropagation();requestError.hidden=true;voiceV2.interrupt();},true);

await restoreConversation();
await refreshRecents();
showSection(["#projects","#activity","#memory","#tools","#approvals","#voice-benchmark"].includes(location.hash)?location.hash.slice(1):"chat");

export { voiceControl };
