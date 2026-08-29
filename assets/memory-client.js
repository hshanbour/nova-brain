import { NovaApiError } from "./api-client.js";

async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } }); }
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
  conversations: () => request("/api/conversations"),
  messages: (id) => request(`/api/conversations/${encodeURIComponent(id)}/messages`)
});
