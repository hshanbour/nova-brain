// This is the shared offer/validation contract, not a grant of edit authority.
export const IMPLEMENTATION_PROTECTED_PATH = /(^|\/)(?:src\/(?:voice|policy|storage|autonomy)(?:\/|$)|speaker-worker(?:\/|$)|assets\/(?:voice-(?!input(?:\.|$))|speaker-)[^/]*(?:\/|$)|\.github(?:\/|$)|api\/index\.js$)|ecapa|elevenlabs|voice-control|production|credential|secret|token/i;
export const FOCUSED_TEST_PATH = /^test\/[a-z0-9._/-]+\.test\.js$/i;
export const evidencePathTokens = value => new Set(String(value).toLowerCase().replace(/\.test(?=\.js$)/, "").replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter(part => part.length > 2 && !new Set(["test", "tests", "asset", "assets", "console"]).has(part)));

const directPathTokens = value => new Set(String(value).toLowerCase().replace(/\.test(?=\.js$)/, "").replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter(part => part.length > 2 && !new Set(["test", "tests", "asset", "assets"]).has(part)));
const sourceStem = value => String(value).toLowerCase().split("/").at(-1).replace(/\.[^.]+$/, "");
const EVIDENCE_STOP_WORDS=new Set(["add","all","and","are","behavior","existing","for","from","into","its","new","preserve","that","the","this","with"]);
export const semanticEvidenceTokens=value=>new Set(String(value||"").replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().match(/[a-z0-9]+/g)?.filter(token=>token.length>2&&!EVIDENCE_STOP_WORDS.has(token))||[]);
const OWNERSHIP_PATTERNS=Object.freeze([
  ["route_registration",/\b(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(|\bpathname\s*===|\bregisterRoute\s*\(/i],
  ["event_handler",/\baddEventListener\s*\(|\bon(?:click|change|input|keydown|keyup|submit|focus|blur)\b/i],
  ["selector_binding",/\b(?:querySelector|querySelectorAll|getElementById)\s*\(|(?:^|[,{\s])[#.][a-z0-9_-]+/i],
  ["exported_symbol",/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/i],
  ["symbol_definition",/\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|\bclass\s+[A-Za-z_$][\w$]*|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/i],
  ["markup_binding",/<[a-z][^>]*(?:\bid|\bclass|\brole|\baria-[a-z-]+)=/i],
  ["configuration_wiring",/\b(?:register|routes?|handlers?|plugins?|adapters?|providers?)\b\s*[:=([]/i],
]);

// A bounded search excerpt may come from a minified physical line. Truncation
// therefore describes the line transport, not whether the visible excerpt can
// prove a concrete ownership anchor. Only explicit definitions/wiring plus a
// task-relevant semantic token become an ownership certificate.
export function sourceOwnershipEvidence(path,matches,{userGoal=""}={}){
  const goal=semanticEvidenceTokens(userGoal),pathTokens=semanticEvidenceTokens(path),certificates=[];
  for(const match of matches||[]){
    const text=String(match?.text||""),tokens=semanticEvidenceTokens(text),matchedTokens=[...tokens].filter(token=>goal.has(token)||pathTokens.has(token)).slice(0,6);
    const pattern=OWNERSHIP_PATTERNS.find(([,expression])=>expression.test(text));
    if(pattern&&matchedTokens.length)certificates.push({basis:pattern[0],matchedTokens,stepId:match.stepId,line:Number.isInteger(match.line)?match.line:null});
  }
  certificates.sort((a,b)=>b.matchedTokens.length-a.matchedTokens.length||a.basis.localeCompare(b.basis));
  return certificates[0]||null;
}

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

export function focusedTestRelationshipEvidence(path,candidatePaths=[],{matchesByPath=new Map()}={}){
  const direct=focusedTestSourceRelationship(path,candidatePaths);
  if(direct.related)return{...direct,basis:"existing_bound_commit_path_relation"};
  const testTokens=new Set((matchesByPath.get(path)||[]).flatMap(match=>[...semanticEvidenceTokens(match?.text)]));
  let best=null;
  for(const sourcePath of candidatePaths.filter(candidate=>!candidate.startsWith("test/"))){
    const sourceTokens=new Set((matchesByPath.get(sourcePath)||[]).flatMap(match=>[...semanticEvidenceTokens(match?.text)]));
    const matchedTokens=[...testTokens].filter(token=>sourceTokens.has(token)).filter(token=>token.length>=4).slice(0,6);
    if((matchedTokens.length>=2||matchedTokens.some(token=>token.length>=7))&&(!best||matchedTokens.length>best.matchedTokens.length))best={related:true,sourcePath,matchedTokens,basis:"repository_search_content_relation"};
  }
  return best||direct;
}

export function plannedTestCreationAuthority(path,{candidatePaths=[],discoveredPaths=new Set()}={}){
  if(!FOCUSED_TEST_PATH.test(path)||IMPLEMENTATION_PROTECTED_PATH.test(path))return{authorized:false,reason:"invalid_or_protected"};
  if(discoveredPaths instanceof Set?discoveredPaths.has(path):discoveredPaths.includes(path))return{authorized:false,reason:"existing_path"};
  const directory=path.slice(0,path.lastIndexOf("/")+1),siblings=[...(discoveredPaths instanceof Set?discoveredPaths:new Set(discoveredPaths))].filter(item=>item.startsWith(directory)&&FOCUSED_TEST_PATH.test(item));
  const relation=focusedTestSourceRelationship(path,candidatePaths);
  return siblings.length>=2&&relation.related
    ?{authorized:true,basis:"existing_test_directory_and_source_path_convention",sourcePath:relation.sourcePath,matchedTokens:relation.matchedTokens,siblingCount:siblings.length}
    :{authorized:false,reason:siblings.length<2?"test_convention_unproven":"source_relationship_unproven"};
}

export function focusedTestEvidenceRelevance(path, { candidatePaths = [], userGoal = "", discoveredPaths = new Set() } = {}) {
  const tokens = new Set([...candidatePaths.filter(candidate => !candidate.startsWith("test/")).flatMap(candidate => [...evidencePathTokens(candidate)]), ...evidencePathTokens(userGoal)]);
  const sourceRelationship = focusedTestSourceRelationship(path, candidatePaths);
  const relevant = sourceRelationship.related || [...evidencePathTokens(path)].some(token => tokens.has(token));
  const discovered = discoveredPaths instanceof Set ? discoveredPaths.has(path) : discoveredPaths.includes(path);
  const classification = IMPLEMENTATION_PROTECTED_PATH.test(path) ? "protected" : !FOCUSED_TEST_PATH.test(path) ? "external" : !discovered ? "nonexistent_invalid" : !relevant ? "unrelated" : !sourceRelationship.related ? "unrelated_source_evidence" : "existing_file";
  return { relevant, sourceRelationship, eligible: classification === "existing_file", classification };
}
