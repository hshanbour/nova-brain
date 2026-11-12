import {PREVIEW_AUTH_URL} from './synthetic-preview.js';
export const CONTINUITY_BRANCH='codex/nova-voice-continuity-preview';
export const CONNECTED_BRANCH='codex/combined-nova-preview-d5b5-c5bd';
export const EXISTING_WORKSPACE_BRANCH='br-empty-violet-za29iebl';
export const EXISTING_WORKSPACE_ENDPOINT='ep-weathered-pine-zan2llcg';
export function continuityPreviewEnvironment(input) {
  const selected=[CONTINUITY_BRANCH,CONNECTED_BRANCH].includes(input.VERCEL_GIT_COMMIT_REF);
  if(!selected)return {environment:input,continuity:false};
  if(input.VERCEL_ENV!=='preview'||input.NOVA_CONTINUITY_PREVIEW!=='true'||input.NEON_AUTH_BASE_URL!==PREVIEW_AUTH_URL||!input.NOVA_PREVIEW_OWNER_EMAIL||!input.NOVA_PREVIEW_OWNER_SUBJECT)throw new Error('Continuity Preview identity binding is incomplete.');
  let database;try{database=new URL(input.DATABASE_URL);}catch{throw new Error('Continuity Preview database binding is invalid.');}
  if(!['postgres:','postgresql:'].includes(database.protocol)||!database.hostname.startsWith(EXISTING_WORKSPACE_ENDPOINT+'.')&&!database.hostname.startsWith(EXISTING_WORKSPACE_ENDPOINT+'-pooler.'))throw new Error('Continuity Preview must use the existing verified Nova workspace endpoint.');
  return {continuity:true,connected:input.VERCEL_GIT_COMMIT_REF===CONNECTED_BRANCH,environment:{...input,NOVA_PHONE_PRIVATE_OWNER_ENABLED:'false',NOVA_SHARP_CUTS_WHATSAPP_EXECUTION_ENABLED:'false',NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED:'false'}};
}
export function continuityRouteAllowed(path,method,{connected=false}={}) {
  // Preserve authenticated webhook intake and worker polling without releasing
  // any existing queue. The API returns a held/no-dispatch result for the poll.
  if(connected&&((path==='/wa'&&['GET','POST'].includes(method))||(method==='POST'&&['/api/admin/worker/auto-dispatch/next','/api/admin/worker/sharp-cuts/whatsapp/tick'].includes(path))))return true;
  if(connected&&method==='POST'&&(/^\/api\/approvals\/[^/]+\/decision$/.test(path)||/^\/api\/admin\/worker\/handoff\/(?:claim|[^/]+\/(?:complete|fail))$/.test(path)||/^\/api\/admin\/coding-jobs\/[^/]+\/progress$/.test(path)||/^\/api\/autonomy\/worker\/tasks\/[^/]+\/tick$/.test(path)||/^\/api\/admin\/worker\/execution-attempts\/[^/]+\/heartbeat$/.test(path)))return true;
  if(path.startsWith('/api/auth/')||path==='/api/preview/session'||path==='/api/preview/isolation')return true;
  if(method==='GET')return !/\/api\/(?:admin|phone|internal|webhooks)\//.test(path)&&path!=='/wa';
  if(method==='POST')return ['/api/agent','/api/memories','/api/voice/readiness','/api/voice/speaker/readiness','/api/voice/speaker/recognize','/api/voice/transcribe','/api/voice/speech','/api/voice/control','/api/voice/telemetry','/api/voice/realtime/session','/api/voice/realtime/authorize-turn','/api/voice/realtime/context','/api/voice/realtime/transcript'].includes(path)||/^\/api\/memory-candidates\/[^/]+\/decision$/.test(path);
  return ['PATCH','DELETE'].includes(method)&&/^\/api\/memories\/[^/]+$/.test(path);
}
export const continuityToolAllowed=(tool,{connected=false}={})=>tool?.riskLevel==='READ_ONLY'||['memory_remember','memory_correct','memory_forget'].includes(tool?.name)||(connected&&['coding_job_prepare','coding_job_create'].includes(tool?.name));
