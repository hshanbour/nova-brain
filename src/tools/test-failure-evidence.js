import {createHash} from "node:crypto";
import {isAbsolute,relative,resolve,sep} from "node:path";

const MAX_EXCERPT=12000,MAX_ITEMS=12;
const clean=text=>String(text||"").replace(/(authorization|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s]+/gi,"$1=[REDACTED]");
const excerpt=text=>{const value=clean(text),truncated=value.length>MAX_EXCERPT;return{value:value.slice(-MAX_EXCERPT),truncated};};
const repoPath=(root,value)=>{const raw=String(value||"").replace(/^file:\/\//,"").replaceAll("\\","/"),withoutLocation=raw.replace(/:\d+(?::\d+)?$/,""),absolute=resolve(withoutLocation),base=resolve(root),rel=(isAbsolute(withoutLocation)||/^[A-Za-z]:\//.test(withoutLocation)?relative(base,absolute):withoutLocation.replace(/^\.\//,"" )).replaceAll(sep,"/");return!rel||rel.startsWith("../")||rel.includes(":")?null:rel;};
const unique=items=>[...new Set(items.filter(Boolean))].slice(0,MAX_ITEMS);
const number=(text,label)=>{const match=String(text).match(new RegExp(`(?:ℹ\\s*)?${label}\\s+(\\d+)`,`i`));return match?Number(match[1]):null;};
export function parseTestFailure({root,runner,command,exitCode=1,signal=null,stdout="",stderr="",durationMs=0}={}){
  const combined=`${stdout}\n${stderr}`,out=excerpt(stdout),err=excerpt(stderr);
  const failedTitles=unique([...combined.matchAll(/^\s*[✖×]\s+(.+)$/gmu)].map(match=>clean(match[1]).slice(0,300)));
  const failedFiles=unique([...combined.matchAll(/(?:file:\/\/\/)?([A-Za-z]:[\\/][^\r\n():]+\.test\.js|(?:test|tests)[\\/][^\r\n():]+\.test\.js)/gi)].map(match=>repoPath(root,match[1])));
  const stackLocations=unique([...combined.matchAll(/(?:file:\/\/\/)?((?:[A-Za-z]:[\\/]|(?:test|tests|src|assets)[\\/])[^\r\n()]+:\d+(?::\d+)?)/gi)].map(match=>{const raw=match[1],path=repoPath(root,raw);const line=raw.match(/:(\d+)(?::(\d+))?$/);return path&&line?`${path}:${line[1]}${line[2]?`:${line[2]}`:""}`:null;}));
  const errorClass=combined.match(/\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error)\b/)?.[1]||null;
  const errorMessage=clean(combined.match(/(?:AssertionError[^:\r\n]*:|Error:)\s*([^\r\n]+)/)?.[1]||failedTitles[0]||"Allowlisted tests failed.").slice(0,500);
  const counts={tests:number(combined,"tests"),passed:number(combined,"pass"),failed:number(combined,"fail"),skipped:number(combined,"skipped")};
  const identity={runner:String(runner||"node_test").slice(0,80),command:String(command||"allowlisted_test").slice(0,120)};
  const fingerprint=createHash("sha256").update(JSON.stringify({identity,exitCode,signal,failedFiles,failedTitles,errorClass,errorMessage,stackLocations})).digest("hex");
  return Object.freeze({version:1,identity,exitCode:Number.isInteger(exitCode)?exitCode:1,signal:signal?String(signal).slice(0,40):null,failedFiles,failedTitles,errorClass,errorMessage,stackLocations,stdoutExcerpt:out.value,stderrExcerpt:err.value,stdoutTruncated:out.truncated,stderrTruncated:err.truncated,durationMs:Math.max(0,Number(durationMs)||0),counts,fingerprint});
}
