import { ValidationError } from "./validation.js";
import Busboy from "busboy";

export async function readJsonBody(request, maxBodyBytes) {
  const contentType = request.headers?.["content-type"] || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ValidationError("Content-Type must include application/json.");
  }

  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;

    if (size > maxBodyBytes) {
      throw new ValidationError("Request body is too large.");
    }

    chunks.push(bytes);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  if (!raw.trim()) {
    throw new ValidationError("Request body must not be empty.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("Request body must contain valid JSON.");
  }
}

export function readMultipartUpload(request,{maxFileBytes,fields=4}={}){
  const contentType=request.headers?.["content-type"]||"";
  if(!contentType.toLowerCase().includes("multipart/form-data"))throw new ValidationError("Content-Type must be multipart/form-data.");
  return new Promise((resolve,reject)=>{
    let parser;try{parser=Busboy({headers:request.headers,limits:{files:1,fields,parts:fields+1,fileSize:maxFileBytes}});}catch{reject(new ValidationError("The multipart upload is invalid."));return;}
    const result={fields:{},file:null};let failed=false;
    const fail=error=>{if(failed)return;failed=true;reject(error);};
    parser.on("field",(name,value)=>{result.fields[name]=String(value).slice(0,2000);});
    parser.on("file",(_name,stream,info)=>{const chunks=[];let size=0;stream.on("data",chunk=>{size+=chunk.length;chunks.push(chunk);});stream.on("limit",()=>fail(new ValidationError("The uploaded document exceeds the allowed size.")));stream.on("end",()=>{if(!failed)result.file={filename:info.filename,mimeType:info.mimeType,buffer:Buffer.concat(chunks,size)};});});
    parser.on("filesLimit",()=>fail(new ValidationError("Only one document may be uploaded at a time.")));
    parser.on("partsLimit",()=>fail(new ValidationError("The multipart upload contains too many parts.")));
    parser.on("error",()=>fail(new ValidationError("The multipart upload is invalid.")));
    parser.on("finish",()=>{if(!failed){if(!result.file)return fail(new ValidationError("A document file is required."));resolve(result);}});
    request.pipe(parser);
  });
}

export async function readFormBody(request, maxBodyBytes) {
  const contentType = request.headers?.["content-type"] || "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) throw new ValidationError("Content-Type must include application/x-www-form-urlencoded.");
  let size = 0; const chunks = [];
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > maxBodyBytes) throw new ValidationError("Request body is too large."); chunks.push(bytes); }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new ValidationError("Request body must not be empty.");
  return Object.fromEntries(new URLSearchParams(raw));
}
