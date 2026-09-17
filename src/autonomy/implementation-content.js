import {createHash} from "node:crypto";

const SCRIPT=/\.(?:[cm]?js|jsx)$/i;
const JSON_FILE=/\.json$/i;
const HTML=/\.html?$/i;
const CSS=/\.css$/i;
const SOURCE=/\.(?:[cm]?js|jsx|ts|tsx|css|html?|json|ps1|sh|py|rb|go|rs|java|kt|swift|php|sql|ya?ml|toml)$/i;
const DECLARATIVE_SCRIPT=/(?:^|\n)\s*(?:import\s|export\s|(?:const|let|var)\s+[A-Za-z_$]|(?:async\s+)?function\s+[A-Za-z_$]|class\s+[A-Za-z_$]|(?:test|it|describe)\s*\()/m;
const SCRIPT_STRUCTURE=/(?:=>|[{};]|(?:^|\n)\s*(?:if|for|while|switch|try)\s*[({])/m;
const SINGLE_EXPRESSION=/^\s*[A-Za-z_$][\w$.[\]'"?]*(?:\([^\n]*\)|\s*=\s*[^\n]+);?\s*$/;
const INSTRUCTION_START=/^(?:add|adjust|change|create|ensure|extend|fix|implement|keep|modify|preserve|remove|replace|revise|update|verify|wire)\b/i;

export const implementationContentHash=value=>createHash("sha256").update(String(value||"")).digest("hex");

export function implementationContentIssue(path,content){
  const value=String(content||""),trimmed=value.trim();
  if(!trimmed)return"replacement_content_empty";
  if(JSON_FILE.test(path)){try{JSON.parse(value);return null;}catch{return"replacement_json_invalid";}}
  if(HTML.test(path))return/<(?:!doctype\s+html|html|head|body|main|section|div|form|button|input|template|script|link|meta)\b/i.test(value)?null:"replacement_html_not_document";
  if(CSS.test(path))return/[^{]+\{[^}]*\}/s.test(value)||/^\s*@(?:charset|import|layer)\b/m.test(value)?null:"replacement_css_not_stylesheet";
  if(SCRIPT.test(path)){
    const codeLike=DECLARATIVE_SCRIPT.test(value)||SCRIPT_STRUCTURE.test(value)||SINGLE_EXPRESSION.test(value);
    if(!codeLike||INSTRUCTION_START.test(trimmed)&&!DECLARATIVE_SCRIPT.test(value)&&!/[{}]/.test(value))return"replacement_script_not_source";
  }else if(SOURCE.test(path)&&INSTRUCTION_START.test(trimmed)&&!/[\n{};:=#]/.test(value))return"replacement_content_looks_instructional";
  return null;
}

export const isJavaScriptImplementationPath=path=>SCRIPT.test(path);
