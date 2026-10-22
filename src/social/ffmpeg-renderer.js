import {execFile} from "node:child_process";
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
