// This is the shared offer/validation contract, not a grant of edit authority.
export const IMPLEMENTATION_PROTECTED_PATH = /(^|\/)(src\/voice|speaker-worker|assets\/(?:voice-(?!input(?:\.|$))|speaker-)|\.github|api\/index\.js|src\/(?:policy|storage|autonomy))(\/|$)|ecapa|elevenlabs|voice-control|production|credential|secret|token/i;
export const FOCUSED_TEST_PATH = /^test\/[a-z0-9._/-]+\.test\.js$/i;
export const evidencePathTokens = value => new Set(String(value).toLowerCase().replace(/\.test(?=\.js$)/, "").replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter(part => part.length > 2 && !new Set(["test", "tests", "asset", "assets", "console"]).has(part)));

export function focusedTestEvidenceRelevance(path, { candidatePaths = [], userGoal = "", discoveredPaths = new Set() } = {}) {
  const tokens = new Set([...candidatePaths.filter(candidate => !candidate.startsWith("test/")).flatMap(candidate => [...evidencePathTokens(candidate)]), ...evidencePathTokens(userGoal)]);
  const relevant = [...evidencePathTokens(path)].some(token => tokens.has(token));
  const discovered = discoveredPaths instanceof Set ? discoveredPaths.has(path) : discoveredPaths.includes(path);
  const classification = IMPLEMENTATION_PROTECTED_PATH.test(path) ? "protected" : !FOCUSED_TEST_PATH.test(path) ? "external" : !discovered ? "nonexistent_invalid" : !relevant ? "unrelated" : "existing_file";
  return { relevant, eligible: classification === "existing_file", classification };
}
