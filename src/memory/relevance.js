export function memoryTokens(value) {
  return new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}

export function memoryRelevance(memory, queryTokens, projectId) {
  const matches = [...memoryTokens(memory.content)].filter((token) => queryTokens.has(token)).length;
  const projectBoost = projectId && memory.projectId === projectId ? 4 : 0;
  const coreBoost = ["identity", "preference", "reusable_instruction"].includes(memory.category) ? 1 : 0;
  return matches + projectBoost + coreBoost;
}

export function rankRelevantMemories(memories, query, { projectId, limit = 6 } = {}) {
  const queryTokens = memoryTokens(query);
  return memories
    .filter((memory) => memory.status === "active")
    .map((memory) => ({ memory, score: memoryRelevance(memory, queryTokens, projectId) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id))
    .slice(0, limit)
    .map(({ memory }) => memory);
}
