import {execFile} from "node:child_process";
import {mkdtemp,mkdir,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {promisify} from "node:util";

const execute=promisify(execFile);
const safeNumber=(value,name,{min=0,max=3600}={})=>{const number=Number(value);if(!Number.isFinite(number)||number<min||number>max)throw new Error(`${name} is invalid.`);return number;};
const safePath=(value,name)=>{const result=String(value||"");if(!result||result.includes("\0")||result.includes("\n")||result.includes("\r"))throw new Error(`${name} is invalid.`);return result;};
const escapeFilterPath=value=>safePath(value,"filter path").replaceAll("\\","/").replaceAll(":","\\:").replaceAll("'","\\'");

export function buildVerticalReelCommand({segments,outputPath,subtitlePath=null,logoPath=null,width=1080,height=1920,fps=30}={}){
  if(!Array.isArray(segments)||!segments.length||segments.length>30)throw new Error("A render requires between 1 and 30 segments.");
  const args=["-hide_banner","-nostdin","-y"],filters=[];
  segments.forEach((segment,index)=>{const start=safeNumber(segment.startSeconds??0,`segments[${index}].startSeconds`),duration=safeNumber(segment.durationSeconds,`segments[${index}].durationSeconds`,{min:.1,max:120}),image=segment.mediaType==="image";if(image)args.push("-loop","1","-t",String(duration),"-i",safePath(segment.path,`segments[${index}].path`));else args.push("-ss",String(start),"-t",String(duration),"-i",safePath(segment.path,`segments[${index}].path`));filters.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p[v${index}]`);if(image||segment.hasAudio===false)filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);else filters.push(`[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);});
  let inputCount=segments.length;if(logoPath){args.push("-i",safePath(logoPath,"logoPath"));filters.push(`[${inputCount}:v]scale='min(220,iw)':-1[logo]`);inputCount+=1;}
  filters.push(`${segments.map((_,index)=>`[v${index}][a${index}]`).join("")}concat=n=${segments.length}:v=1:a=1[basev][aout]`);
  let video="basev";
  if(subtitlePath){filters.push(`[${video}]subtitles='${escapeFilterPath(subtitlePath)}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=140'[subv]`);video="subv";}
  if(logoPath){filters.push(`[${video}][logo]overlay=W-w-48:48:format=auto[outv]`);video="outv";}
  args.push("-filter_complex",filters.join(";"),"-map",`[${video}]`,"-map","[aout]","-c:v","libx264","-preset","medium","-crf","19","-profile:v","high","-level","4.1","-c:a","aac","-b:a","192k","-movflags","+faststart","-metadata","comment=Rendered locally by Nova from owner-provided media",safePath(outputPath,"outputPath"));
  return args;
}

export async function inspectFfmpeg({executable="ffmpeg"}={}){
  try{const result=await execute(executable,["-version"],{windowsHide:true,timeout:5000,maxBuffer:1024*1024});return{available:true,version:String(result.stdout).split(/\r?\n/)[0]||"unknown"};}catch(error){return{available:false,code:error?.code||"ffmpeg_unavailable"};}
}

export async function renderVerticalReel(input,{executable="ffmpeg"}={}){
  const readiness=await inspectFfmpeg({executable});if(!readiness.available)throw Object.assign(new Error("FFmpeg is not installed or is not available to the Nova media worker."),{code:"ffmpeg_unavailable"});
  const args=buildVerticalReelCommand(input);await execute(executable,args,{windowsHide:true,timeout:30*60*1000,maxBuffer:4*1024*1024});return{outputPath:input.outputPath,renderer:readiness.version};
}

const ffprobeFor=executable=>{const value=safePath(executable,"FFmpeg executable");return /ffmpeg(?:\.exe)?$/i.test(value)?value.replace(/ffmpeg(\.exe)?$/i,"ffprobe$1"):"ffprobe";};

export async function extractVisualSamples({inputPath,outputDirectory,sampleCount=6},{executable="ffmpeg",ffprobeExecutable=ffprobeFor(executable),executeImpl=execute,inspectImpl=inspectFfmpeg}={}){
  const source=safePath(inputPath,"inputPath"),count=Number(sampleCount);if(!Number.isInteger(count)||count<2||count>6)throw new Error("Visual analysis requires between 2 and 6 samples.");
  const readiness=await inspectImpl({executable});if(!readiness.available)throw Object.assign(new Error("FFmpeg is not installed or is not available to sample footage."),{code:"ffmpeg_unavailable"});
  let probe;try{probe=await executeImpl(ffprobeExecutable,["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",source],{windowsHide:true,timeout:30_000,maxBuffer:1024*1024});}catch(error){throw Object.assign(new Error("FFprobe could not inspect the local footage."),{code:error?.code||"ffprobe_unavailable"});}
  const duration=Number(String(probe.stdout||"").trim());if(!Number.isFinite(duration)||duration<.2||duration>4*60*60)throw Object.assign(new Error("The local footage duration is outside the analysis limit."),{code:"media_duration_invalid"});
  const base=safePath(outputDirectory,"outputDirectory");await mkdir(base,{recursive:true});const temporary=await mkdtemp(join(base,"sample-")),samples=[];
  try{for(let index=0;index<count;index+=1){const timestamp=Math.round(duration*((index+1)/(count+1))*100)/100,path=join(temporary,`${String(index).padStart(2,"0")}.jpg`);await executeImpl(executable,["-hide_banner","-nostdin","-y","-ss",String(timestamp),"-i",source,"-frames:v","1","-vf","scale='min(384,iw)':-2","-q:v","7",path],{windowsHide:true,timeout:60_000,maxBuffer:2*1024*1024});const bytes=await readFile(path);if(bytes.length<16||bytes.length>128*1024)throw Object.assign(new Error("A sampled frame is outside the privacy size limit."),{code:"media_sample_size_invalid"});samples.push({timestampSeconds:timestamp,jpegBase64:bytes.toString("base64")});}return{durationSeconds:Math.round(duration*100)/100,samples,renderer:readiness.version};}finally{await rm(temporary,{recursive:true,force:true});}
}
