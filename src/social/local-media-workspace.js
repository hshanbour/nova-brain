import {createHash,randomBytes} from "node:crypto";
import {createReadStream,createWriteStream} from "node:fs";
import {mkdir,rename,stat,unlink} from "node:fs/promises";
import {basename,extname,join,resolve,sep} from "node:path";
import {pipeline} from "node:stream/promises";

const EXTENSIONS=new Set([".mp4",".mov",".m4v",".jpg",".jpeg",".png",".webp"]);
const MIME=Object.freeze({".mp4":"video/mp4",".mov":"video/quicktime",".m4v":"video/x-m4v",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp"});
const inside=(root,target)=>target===root||target.startsWith(`${root}${sep}`);

export function createLocalMediaWorkspace({root,maxBytes=8*1024**3}={}){
  const workspace=resolve(String(root||""));if(!root)throw new Error("A dedicated Sharp Cuts media root is required.");
  return Object.freeze({
    root:workspace,
    async ingest({sourcePath,projectId="sharp-cuts-web"}={}){
      if(projectId!=="sharp-cuts-web")throw Object.assign(new Error("This local workspace is restricted to the Sharp Cuts project."),{code:"media_project_not_allowed"});
      const source=resolve(String(sourcePath||"")),extension=extname(source).toLowerCase();if(!EXTENSIONS.has(extension))throw Object.assign(new Error("Unsupported media file type."),{code:"media_type_unsupported"});
      const sourceStats=await stat(source);if(!sourceStats.isFile()||sourceStats.size<=0||sourceStats.size>maxBytes)throw Object.assign(new Error("Media file size is outside the configured local limit."),{code:"media_size_invalid"});
      const capability=randomBytes(24).toString("hex"),directory=resolve(workspace,projectId,"originals");if(!inside(workspace,directory))throw new Error("Unsafe media path.");await mkdir(directory,{recursive:true});
      const destination=resolve(directory,`${capability}${extension}`),temporary=`${destination}.partial`;if(!inside(workspace,destination))throw new Error("Unsafe media path.");const hash=createHash("sha256");
      const input=createReadStream(source);input.on("data",chunk=>hash.update(chunk));try{await pipeline(input,createWriteStream(temporary,{flags:"wx",mode:0o600}));await rename(temporary,destination);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
      return{localCapabilityId:capability,sha256:hash.digest("hex"),bytes:sourceStats.size,mimeType:MIME[extension],type:MIME[extension].startsWith("video/")?"video":"image",originalName:basename(source),storedPath:destination};
    },
    resolveCapability(projectId,capability,extension){if(projectId!=="sharp-cuts-web"||!/^[a-f0-9]{48}$/.test(capability)||!EXTENSIONS.has(extension))throw new Error("Invalid local media capability.");const target=resolve(workspace,projectId,"originals",`${capability}${extension}`);if(!inside(workspace,target))throw new Error("Unsafe media path.");return target;}
  });
}
