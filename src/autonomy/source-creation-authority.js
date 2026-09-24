import {createHash} from "node:crypto";

export const MAX_AUTHORIZED_NEW_SOURCE_PATHS=4;
const SOURCE_EXTENSION=/\.(?:c?js|mjs|ts|tsx|jsx|css|html)$/i;
const FORBIDDEN=/(^|\/)(?:\.git|node_modules|vendor|dist|build|coverage|\.env|credentials?|secrets?|production)(?:\/|$)/i;
const STOP=new Set(["add","and","build","change","create","develop","edit","feature","file","fix","implement","improve","module","new","nova","source","the","update","with"]);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const singular=value=>value.length>4&&value.endsWith("ies")?`${value.slice(0,-3)}y`:value.length>3&&value.endsWith("s")?value.slice(0,-1):value;
export const sourceCreationTokens=value=>[...new Set((String(value||"").replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().match(/[a-z0-9]+/g)||[]).map(singular).filter(token=>token.length>2&&!STOP.has(token)))];
export const safeNewSourcePath=value=>{
  const path=String(value||"").trim().replaceAll("\\","/");
  if(!path||path.length>240||path.startsWith("/")||path.includes("..")||path.includes("//")||FORBIDDEN.test(path)||!SOURCE_EXTENSION.test(path)||!path.includes("/"))return null;
  return /^[a-z0-9._/-]+$/i.test(path)?path:null;
};
const parts=path=>{const slash=path.lastIndexOf("/"),name=path.slice(slash+1),dot=name.lastIndexOf("."),stem=name.slice(0,dot),extension=name.slice(dot).toLowerCase();return{directory:path.slice(0,slash),stem,extension,tokens:sourceCreationTokens(stem)};};

// Directory and naming authority is derived only from existing bound-repository
// paths. The model may choose a name within this envelope, but never creates the
// envelope or expands it.
export function deriveSourceCreationAuthorities(paths,{userGoal="",maxAuthorities=6}={}){
  const goal=new Set(sourceCreationTokens(userGoal)),groups=new Map();
  for(const raw of paths||[]){const path=safeNewSourcePath(raw);if(!path||path.startsWith("test/")||FORBIDDEN.test(path))continue;const item=parts(path),key=`${item.directory}|${item.extension}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({path,...item});}
  const authorities=[];
  for(const siblings of groups.values()){
    const unique=[...new Map(siblings.map(item=>[item.path,item])).values()].sort((a,b)=>a.path.localeCompare(b.path));
    if(unique.length<2)continue;
    const directory=unique[0].directory,extension=unique[0].extension,directoryTokens=sourceCreationTokens(directory),lastCounts=new Map();
    for(const sibling of unique)if(sibling.tokens.length>1){const last=sibling.tokens.at(-1);lastCounts.set(last,(lastCounts.get(last)||0)+1);}
    const suffix=[...lastCounts].filter(([,count])=>count>=2).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||null;
    const namingStyle=suffix?"semantic_kebab_suffix":unique.every(item=>/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(item.stem))?"semantic_kebab":null;
    if(!namingStyle)continue;
    const matchedGoalTokens=[...new Set([...directoryTokens,...(suffix?[suffix]:[])].filter(token=>goal.has(token)))];
    if(!matchedGoalTokens.length)continue;
    const record={version:1,directory,extension,namingStyle,suffix,evidencePaths:unique.slice(0,4).map(item=>item.path),siblingCount:unique.length,matchedGoalTokens};
    authorities.push({...record,authorityHash:hash(record)});
  }
  authorities.sort((a,b)=>b.matchedGoalTokens.length-a.matchedGoalTokens.length||b.siblingCount-a.siblingCount||a.directory.localeCompare(b.directory));
  if(authorities.length>1&&authorities[0].matchedGoalTokens.length===authorities[1].matchedGoalTokens.length&&authorities[0].siblingCount===authorities[1].siblingCount)return[];
  return authorities.slice(0,Math.max(0,Math.min(6,maxAuthorities)));
}

export function authorizeNewSourcePath(value,{authorities=[],userGoal="",existingPaths=[]}={}){
  const path=safeNewSourcePath(value);if(!path)return{authorized:false,reason:"invalid_or_sensitive_path"};
  const existing=existingPaths instanceof Set?existingPaths:new Set(existingPaths);if(existing.has(path))return{authorized:false,reason:"existing_path"};
  const item=parts(path),goal=new Set(sourceCreationTokens(userGoal)),matches=authorities.filter(authority=>{if(!authority||typeof authority!=="object")return false;const{authorityHash,...record}=authority;return authority.version===1&&authority.directory===item.directory&&authority.extension===item.extension&&Array.isArray(authority.evidencePaths)&&authority.evidencePaths.length>=2&&authority.evidencePaths.every(evidence=>existing.has(evidence))&&authorityHash===hash(record);});
  if(matches.length!==1)return{authorized:false,reason:matches.length?"ambiguous_location":"location_unproven"};
  const authority=matches[0],semantic=item.tokens.filter(token=>goal.has(token)&&token!==authority.suffix);
  if(!semantic.length)return{authorized:false,reason:"name_not_goal_bound"};
  if(authority.namingStyle==="semantic_kebab_suffix"&&(!authority.suffix||item.tokens.at(-1)!==authority.suffix||!/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(item.stem)))return{authorized:false,reason:"naming_convention_mismatch"};
  if(authority.namingStyle==="semantic_kebab"&&!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(item.stem))return{authorized:false,reason:"naming_convention_mismatch"};
  const record={version:1,path,operation:"create",baselineExists:false,authorityHash:authority.authorityHash,directory:authority.directory,extension:authority.extension,namingStyle:authority.namingStyle,suffix:authority.suffix,evidencePaths:[...authority.evidencePaths],matchedGoalTokens:semantic.slice(0,6)};
  return{authorized:true,record:{...record,recordHash:hash(record)}};
}

export function verifySourceCreationRecord(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const {recordHash,baselineCommit,...record}=value;
  return record.baselineExists===false&&/^[a-f0-9]{40}$/.test(baselineCommit||"")&&/^[a-f0-9]{64}$/.test(recordHash||"")&&recordHash===hash(record);
}
