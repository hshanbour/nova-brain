const SAFE_TEXT=/^[A-Za-z0-9_.:/-]{1,160}$/;
const TYPE_NAMES=new Set(["array","boolean","integer","missing","null","number","object","string","undefined"]);
const safeText=(value,max=160)=>typeof value==="string"&&SAFE_TEXT.test(value)&&value.length<=max?value:null;
const structural=value=>{
  if(value===null)return{type:"null"};
  if(Array.isArray(value))return{type:"array"};
  const type=typeof value;
  return{type:TYPE_NAMES.has(type)?type:"unknown"};
};
const shape=value=>{
  if(value&&typeof value==="object"&&!Array.isArray(value)&&TYPE_NAMES.has(value.type)){
    const output={type:value.type};
    if(Array.isArray(value.enum)&&value.enum.length<=20&&value.enum.every(item=>typeof item==="string"&&SAFE_TEXT.test(item)))output.enum=[...value.enum];
    if(safeText(value.classification))output.classification=value.classification;
    return output;
  }
  if(typeof value==="string"&&TYPE_NAMES.has(value))return{type:value};
  if(value==="required")return{type:"required"};
  if(value==="declared_property")return{type:"declared_property"};
  return structural(value);
};

export function canonicalSchemaDiagnostic(input={}){
  const diagnostic={
    version:1,
    taskId:safeText(input.taskId),handoffId:safeText(input.handoffId),stepId:safeText(input.stepId),stepType:safeText(input.stepType),tool:safeText(input.tool),
    schemaVersion:safeText(String(input.schemaVersion||"1")),fieldPath:safeText(input.fieldPath),expected:shape(input.expected),received:shape(input.received),
    validationCode:safeText(input.validationCode)||"schema_mismatch",validationLayer:safeText(input.validationLayer),payloadProvenance:safeText(input.payloadProvenance)
  };
  if(safeText(input.plannerGenerationId))diagnostic.plannerGenerationId=input.plannerGenerationId;
  if(safeText(input.continuationGenerationId))diagnostic.continuationGenerationId=input.continuationGenerationId;
  if(Array.isArray(input.argumentKeys))diagnostic.argumentKeys=[...new Set(input.argumentKeys.filter(key=>safeText(key)).slice(0,30))].sort();
  return diagnostic;
}

export function localSchemaDiagnostic(input={}){const value=canonicalSchemaDiagnostic(input);return{handoffId:value.handoffId,validationCode:value.validationCode,tool:value.tool,fieldPath:value.fieldPath,validationLayer:value.validationLayer};}
