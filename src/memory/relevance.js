import {createProjectService} from "../projects/project-service.js";

export function memoryTokens(value) {
  return new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}

export function memoryRelevance(memory, queryTokens, projectId) {
  const matches = [...memoryTokens(memory.content)].filter((token) => queryTokens.has(token)).length;
  const projectBoost = projectId && memory.projectId === projectId ? 4 : 0;
  const coreBoost = ["identity", "preference", "reusable_instruction"].includes(memory.category) ? 1 : 0;
  return matches + projectBoost + coreBoost;
}

export function rankRelevantMemories(memories, query, { projectId, projectIds=projectId?[projectId]:[], limit = 6 } = {}) {
  const queryTokens = memoryTokens(query);
  return memories
    .filter((memory) => memory.status === "active"&&(memory.projectId==null||["global","system"].includes(memory.scope)||projectIds.includes(memory.projectId)))
    .map((memory) => ({ memory, score: memoryRelevance(memory, queryTokens, projectId) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id))
    .slice(0, limit)
    .map(({ memory }) => memory);
}

export async function resolveMemoryProjectIds(storage,ownerId,query,projectId){
  if(projectId)return[projectId];
  if(typeof storage.listProjects!=="function")return[];
  const resolution=await createProjectService({storage,ownerId}).resolve({message:query});
  if(resolution.status==="resolved")return[resolution.project.id];
  // A direct owner read may compare explicitly named projects; ambiguous partial names do not widen scope.
  return resolution.status==="multiple"?(resolution.projects||[]).map(p=>p.id):[];
}
