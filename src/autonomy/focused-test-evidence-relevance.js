// This is the shared offer/validation contract, not a grant of edit authority.
export const IMPLEMENTATION_PROTECTED_PATH = /(^|\/)(?:src\/(?:voice|policy|storage|autonomy)(?:\/|$)|speaker-worker(?:\/|$)|assets\/(?:voice-(?!input(?:\.|$))|speaker-)[^/]*(?:\/|$)|\.github(?:\/|$)|api\/index\.js$)|ecapa|elevenlabs|voice-control|production|credential|secret|token/i;
export const FOCUSED_TEST_PATH = /^test\/[a-z0-9._/-]+\.test\.js$/i;
export const evidencePathTokens = value => new Set(String(value).toLowerCase().replace(/\.test(?=\.js$)/, "").replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter(part => part.length > 2 && !new Set(["test", "tests", "asset", "assets", "console"]).has(part)));

const directPathTokens = value => new Set(String(value).toLowerCase().replace(/\.test(?=\.js$)/, "").replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter(part => part.length > 2 && !new Set(["test", "tests", "asset", "assets"]).has(part)));
const sourceStem = value => String(value).toLowerCase().split("/").at(-1).replace(/\.[^.]+$/, "");

// Existing focused-test evidence must be tied to implementation ownership, not
// merely to broad goal language such as "preserve Voice Mode". Exact module
// stems, two path tokens, or one distinctive long token are bounded,
// deterministic evidence of that relationship. This intentionally keeps
// regression-only suites out of mutation-authoritative planner context.
export function focusedTestSourceRelationship(path, candidatePaths = []) {
  const testTokens = directPathTokens(path), sources = candidatePaths.filter(candidate => !candidate.startsWith("test/"));
  let best = Object.freeze({related:false,sourcePath:null,matchedTokens:[]});
  for (const sourcePath of sources) {
    const matchedTokens = [...directPathTokens(sourcePath)].filter(token => testTokens.has(token));
    const stem = sourceStem(sourcePath), exactStem = stem.length > 2 && String(path).toLowerCase().includes(stem);
    const related = exactStem || matchedTokens.length >= 2 || matchedTokens.some(token => token.length >= 6);
    if (related && matchedTokens.length >= best.matchedTokens.length) best = Object.freeze({related:true,sourcePath,matchedTokens});
  }
  return best;
}

export function focusedTestEvidenceRelevance(path, { candidatePaths = [], userGoal = "", discoveredPaths = new Set() } = {}) {
  const tokens = new Set([...candidatePaths.filter(candidate => !candidate.startsWith("test/")).flatMap(candidate => [...evidencePathTokens(candidate)]), ...evidencePathTokens(userGoal)]);
  const sourceRelationship = focusedTestSourceRelationship(path, candidatePaths);
  const relevant = sourceRelationship.related || [...evidencePathTokens(path)].some(token => tokens.has(token));
  const discovered = discoveredPaths instanceof Set ? discoveredPaths.has(path) : discoveredPaths.includes(path);
  const classification = IMPLEMENTATION_PROTECTED_PATH.test(path) ? "protected" : !FOCUSED_TEST_PATH.test(path) ? "external" : !discovered ? "nonexistent_invalid" : !relevant ? "unrelated" : !sourceRelationship.related ? "unrelated_source_evidence" : "existing_file";
  return { relevant, sourceRelationship, eligible: classification === "existing_file", classification };
}
