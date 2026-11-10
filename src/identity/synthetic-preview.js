// Deliberately pinned to the newly provisioned, empty Free project. Never use
// a generic DATABASE_URL fallback in this sandbox, even if Vercel inherits it.
export const PREVIEW_GIT_BRANCH = 'codex/nova-auth-synthetic-preview';
export const PREVIEW_NEON_BRANCH = 'br-divine-tree-bcxt8825';
export const PREVIEW_ENDPOINT = 'ep-nameless-breeze-bce5lrtd';
export const PREVIEW_AUTH_URL = `https://${PREVIEW_ENDPOINT}.neonauth.c-16.us-east-1.aws.neon.tech/neondb/auth`;
export const SYNTHETIC_OWNER_ID = 'owner_preview_synthetic';
export const SYNTHETIC_SEED = Object.freeze({
  owner: {id:SYNTHETIC_OWNER_ID, fullName:'Synthetic Preview Owner', preferredName:'Preview Owner', arabicName:'مالك الاختبار', facts:{synthetic:true}, preferences:{replyLanguage:'ar',arabic:'Natural Levantine Arabic'}, goals:[],context:{synthetic:true},provenance:'synthetic-test-fixture',privacy:'private'},
  projects:[{id:'synthetic-lantern',name:'Synthetic Lantern',description:'Fictional test project. Its test colour is violet. No real business, customer or integration.'}],
  memories:[{id:'synthetic-language',category:'preference',content:'This synthetic workspace prefers natural Arabic replies.',provenance:'synthetic-test-fixture',privacy:'private',sensitivity:'ordinary',scope:'global',status:'active'}],
});
export function syntheticPreviewEnvironment(input={}) {
  const selected=input.NOVA_SYNTHETIC_PREVIEW==='true';
  if(!selected) {
    if(input.VERCEL_GIT_COMMIT_REF===PREVIEW_GIT_BRANCH)throw new Error('Synthetic Preview isolation must be explicitly configured.');
    return {environment:input,synthetic:false};
  }
  if(input.VERCEL_ENV!=='preview'||input.VERCEL_GIT_COMMIT_REF!==PREVIEW_GIT_BRANCH)throw new Error('Synthetic Preview requires its dedicated Preview branch.');
  let db;try{db=new URL(input.NOVA_SYNTHETIC_DATABASE_URL);}catch{throw new Error('Synthetic database binding is missing or invalid.');}
  if(!['postgres:','postgresql:'].includes(db.protocol)||!new RegExp(`^${PREVIEW_ENDPOINT}(-pooler)?\\.c-16\\.us-east-1\\.aws\\.neon\\.tech$`).test(db.hostname)||db.pathname!=='/neondb'||db.searchParams.get('sslmode')!=='require')throw new Error('Synthetic database endpoint does not match the isolated project.');
  if(input.NEON_AUTH_BASE_URL!==PREVIEW_AUTH_URL)throw new Error('Synthetic Auth endpoint does not match the isolated project.');
  // Allowlist instead of removing selected secrets. Newly added providers cannot
  // accidentally inherit Production/other-Preview credentials or execute flags.
  const names=['VERCEL_ENV','VERCEL_GIT_COMMIT_REF','VERCEL_URL','NODE_ENV','PORT','NOVA_SYNTHETIC_PREVIEW','NEON_AUTH_BASE_URL','NOVA_PREVIEW_OWNER_EMAIL','NOVA_PREVIEW_OWNER_SUBJECT'];
  const environment=Object.fromEntries(names.filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
  Object.assign(environment,{DATABASE_URL:db.href,NOVA_BRAIN_MODEL_PROVIDER:'mock',NOVA_BRAIN_STORAGE_PROVIDER:'postgres',NOVA_SHARP_CUTS_WHATSAPP_EXECUTION_ENABLED:'false',NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED:'false',NOVA_PHONE_PRIVATE_OWNER_ENABLED:'false'});
  return {environment,synthetic:true};
}
export async function assertSyntheticDatabase(run) {
  const rows=await run("SELECT current_setting('neon.branch_id') AS branch, current_setting('neon.endpoint_id') AS endpoint");
  if(rows?.[0]?.branch!==PREVIEW_NEON_BRANCH||rows[0].endpoint!==PREVIEW_ENDPOINT)throw new Error('Synthetic database identity verification failed.');
}
export function syntheticRouteAllowed(path,method) {
  if(method==='GET')return ['/api/health','/api/owner/profile','/api/projects','/api/memories','/api/conversations'].includes(path)||/^\/api\/conversations\/[A-Za-z0-9_-]+(?:\/messages)?$/.test(path);
  if(method==='POST')return ['/api/agent','/api/memories'].includes(path);
  return ['PATCH','DELETE'].includes(method)&&/^\/api\/memories\/[A-Za-z0-9_-]+$/.test(path);
}
