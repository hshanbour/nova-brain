import {canonicalContentHash} from "./self-development-plan-lifecycle.js";

export const REVIEW_TEST_IDENTITY_PATHS=Object.freeze([
  "test/composer-dictation.test.js",
  "test/composer-voice-console.integration.test.js",
  "test/console-static.test.js",
  "test/voice-input.test.js",
]);

function fail(predicate){
  throw Object.assign(new Error(`Current test identity inventory rejected: ${predicate}.`),{
    code:"test_identity_inventory_invalid",
    safeDiagnostics:{predicate,mutationApplied:false},
  });
}

function tokens(source){
  const result=[];
  for(let index=0;index<source.length;){
    const char=source[index],next=source[index+1];
    if(/\s/.test(char)){index++;continue;}
    if(char==="/"&&next==="/"){index+=2;while(index<source.length&&!/[\r\n]/.test(source[index]))index++;continue;}
    if(char==="/"&&next==="*"){const end=source.indexOf("*/",index+2);if(end<0)fail("unterminated_comment");index=end+2;continue;}
    if(char==="/"){
      const previous=result.at(-1),regexStart=!previous||(previous.type==="punctuation"&&/[([{=,:;!?&|>]/.test(previous.value))||(previous.type==="identifier"&&["return","case","throw","yield","await"].includes(previous.value));
      if(regexStart){index++;let escaped=false,inClass=false,closed=false;while(index<source.length){const current=source[index++];if(escaped){escaped=false;continue;}if(current==="\\"){escaped=true;continue;}if(current==="["){inClass=true;continue;}if(current==="]"){inClass=false;continue;}if(current==="/"&&!inClass){closed=true;break;}if(/[\r\n]/.test(current))break;}if(!closed)fail("unterminated_regex");while(index<source.length&&/[A-Za-z]/.test(source[index]))index++;result.push({type:"regex",value:"/"});continue;}
    }
    if(/[A-Za-z_$]/.test(char)){const start=index++;while(index<source.length&&/[A-Za-z0-9_$]/.test(source[index]))index++;result.push({type:"identifier",value:source.slice(start,index)});continue;}
    if(char==="'"||char==='"'||char==="`"){
      const quote=char,start=index++;let value="",supported=true,closed=false;
      while(index<source.length){const current=source[index++];if(current===quote){closed=true;break;}if(current==="\\"){supported=false;if(index<source.length)index++;continue;}if(quote==="`"&&current==="$"&&source[index]==="{")supported=false;value+=current;}
      if(!closed)fail("unterminated_string");result.push({type:"string",value,supported,start});continue;
    }
    result.push({type:"punctuation",value:char});index++;
  }
  return result;
}

export function deriveCurrentTestIdentityInventory(reads,{paths=REVIEW_TEST_IDENTITY_PATHS}={}){
  if(!(reads instanceof Map)||!Array.isArray(paths)||paths.length!==4||new Set(paths).size!==4)fail("inventory_scope");
  const inventory=[];
  for(const path of paths){
    const source=reads.get(path);if(typeof source!=="string"||source.length===0)fail("test_source_missing");
    const stream=tokens(source),names=[];
    for(let index=0;index<stream.length;index++){
      if(stream[index].type!=="identifier"||!["test","it"].includes(stream[index].value))continue;
      if(stream[index-1]?.value===".")continue;
      let cursor=index+1;
      if(stream[cursor]?.value==="."){
        const modifier=stream[cursor+1];
        if(modifier?.type!=="identifier"||!["only","skip","todo"].includes(modifier.value))continue;
        cursor+=2;
      }
      if(stream[cursor]?.value!=="(")continue;
      const name=stream[cursor+1];
      if(name?.type!=="string"||name.supported!==true||!name.value.trim()||name.value.length>300)fail("unsupported_test_identity");
      if(![",",")"].includes(stream[cursor+2]?.value))fail("unsupported_test_identity");
      names.push(name.value);
    }
    if(names.length===0||new Set(names).size!==names.length)fail("ambiguous_test_identity");
    const sourceHash=canonicalContentHash(source);
    for(const testName of names)inventory.push({testPath:path,testName,sourceHash});
  }
  return Object.freeze(inventory.sort((a,b)=>a.testPath.localeCompare(b.testPath)||a.testName.localeCompare(b.testName)).map(Object.freeze));
}
