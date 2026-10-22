import { NovaApiError } from "./api-client.js";

async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } }); }
  catch { throw new NovaApiError("Nova's private memory could not be reached."); }
  let result;
  try { result = await response.json(); }
  catch { throw new NovaApiError("Nova returned an unreadable response.", response.status); }
  if (!response.ok) throw new NovaApiError(result?.error || "The memory request could not be completed.", response.status);
  return result;
}

export const ownerMemoryClient = Object.freeze({
  profile: () => request("/api/owner/profile"),
  updateProfile: (patch) => request("/api/owner/profile", { method: "PATCH", body: JSON.stringify(patch) }),
  list: (category = "") => request(`/api/memories${category ? `?category=${encodeURIComponent(category)}` : ""}`),
  create: (memory) => request("/api/memories", { method: "POST", body: JSON.stringify(memory) }),
  update: (id, patch) => request(`/api/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  forget: (id) => request(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  memoryCandidates: ({status="pending",limit=100}={}) => request(`/api/memory-candidates?status=${encodeURIComponent(status)}&limit=${limit}`),
  decideMemoryCandidate: (id,input) => request(`/api/memory-candidates/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(input) }),
  conversations: () => request("/api/conversations"),
  messages: (id, { offset = 0, limit = 100 } = {}) => request(`/api/conversations/${encodeURIComponent(id)}/messages?limit=${limit}&offset=${offset}`),
  projects: () => request("/api/projects"),
  createProject: (input) => request("/api/projects", { method: "POST", body: JSON.stringify(input) }),
  projectDiscoveryCatalog: () => request("/api/project-discovery/catalog"),
  startVercelAccountOAuth: () => request("/api/integrations/vercel/oauth/start", { method: "POST" }),
  disconnectVercelAccount: () => request("/api/integrations/vercel", { method: "DELETE" }),
  inspectAuthorisedProject: (input) => request("/api/project-discovery/inspect", { method: "POST", body: JSON.stringify(input) }),
  importAuthorisedProject: (input) => request("/api/project-discovery/import", { method: "POST", body: JSON.stringify(input) }),
  projectOnboarding: (id) => request(`/api/projects/${encodeURIComponent(id)}/onboarding`),
  proposeProjectKnowledge: (id,input) => request(`/api/projects/${encodeURIComponent(id)}/knowledge-candidates`, { method: "POST", body: JSON.stringify(input) }),
  uploadProjectDocument: (id,file) => { const body=new FormData();body.append("document",file);return request(`/api/projects/${encodeURIComponent(id)}/documents`,{method:"POST",body}); },
  ingestProjectUrl: (id,input) => request(`/api/projects/${encodeURIComponent(id)}/url-ingestions`,{method:"POST",body:JSON.stringify(input)}),
  revokeProjectSource: (id) => request(`/api/project-sources/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }),
  modelBudget: () => request("/api/model-budget"),
  activity: () => request("/api/activity"),
  task: (id) => request(`/api/autonomy/tasks/${encodeURIComponent(id)}`),
  taskActivity: (id) => request(`/api/activity?runId=${encodeURIComponent(id)}&limit=100`),
  cancelTask: (id) => request(`/api/autonomy/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  tools: () => request("/api/tools"),
  socialDashboard: (projectId = "") => request(`/api/social/dashboard${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  startInstagramOAuth: (projectId, provider) => request("/api/integrations/instagram/oauth/start", { method: "POST", body: JSON.stringify({projectId,provider}) }),
  socialContent: (id) => request(`/api/social/content/${encodeURIComponent(id)}`),
  reviseSocialContent: (id,input) => request(`/api/social/content/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  submitSocialReview: (id) => request(`/api/social/content/${encodeURIComponent(id)}/submit-review`, { method: "POST", body: "{}" }),
  requestSocialRevision: (id,input={}) => request(`/api/social/content/${encodeURIComponent(id)}/request-revision`, { method: "POST", body: JSON.stringify(input) }),
  cancelSocialPublication: (id) => request(`/api/social/publications/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  createSocialLaunchBatch: (projectId) => request("/api/social/launch-batch", { method: "POST", body: JSON.stringify({ projectId }) }),
  refreshSocialMetrics: (projectId) => request("/api/social/metrics/refresh", { method: "POST", body: JSON.stringify({ projectId }) }),
  socialMediaDashboard: (projectId) => request(`/api/social/media/dashboard?projectId=${encodeURIComponent(projectId)}`),
  requestSocialMediaApproval: (input) => request("/api/social/media/request-approval", { method: "POST", body: JSON.stringify(input) }),
  refreshSocialCalendar: (projectId) => request("/api/social/calendar/refresh", { method: "POST", body: JSON.stringify({ projectId }) }),
  sharpCutsAutomationDashboard: () => request("/api/business-automation/sharp-cuts/dashboard"),
  runSharpCutsRetentionDemo: () => request("/api/business-automation/sharp-cuts/retention-demo", { method: "POST", body: "{}" }),
  approvals: ({ status, conversationId, limit } = {}) => {
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    if (conversationId) query.set("conversationId", conversationId);
    if (limit) query.set("limit", String(limit));
    const suffix = query.size ? `?${query}` : "";
    return request(`/api/approvals${suffix}`);
  },
  gmailStatus: () => request("/api/integrations/gmail/status"),
  phoneCalls: (conversationId) => request(conversationId ? `/api/phone/calls?conversationId=${encodeURIComponent(conversationId)}` : "/api/phone/calls?limit=50"),
  phoneCall: (id) => request(`/api/phone/calls/${encodeURIComponent(id)}`),
  ownerContactPolicy: () => request("/api/phone/owner-contact-policy"),
  configureOwnerContactPolicy: (input) => request("/api/phone/owner-contact-policy", { method: "POST", body: JSON.stringify(input) }),
  disableOwnerContactPolicy: (revoke = false) => request("/api/phone/owner-contact-policy/disable", { method: "POST", body: JSON.stringify({ revoke }) }),
  decideApproval: (id, decision) => request(`/api/approvals/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ decision }) })
});
