import {hkdfSync} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {createAuthServer,handleAuthProxyRequest,extractNeonAuthCookies,serializeSetCookie} from '@neon/auth/server';
import {PREVIEW_AUTH_URL,SYNTHETIC_OWNER_ID,assertSyntheticDatabase,PREVIEW_NEON_BRANCH} from './synthetic-preview.js';
import {ConsoleAccessError} from './console-access.js';
import {readJsonBody} from '../http/body.js';

const silent={debug(){},info(){},warn(){},error(){}};
function json(res,status,value){res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(value));}
export function workspaceActor(session,environment) {
  const user=session?.user;
  const expiry=new Date(session?.session?.expiresAt).getTime();
  if(!user?.id||!session?.session||session.session.userId!==user.id||!Number.isFinite(expiry)||expiry<=Date.now())throw new ConsoleAccessError('console_identity_required');
  if(user.emailVerified!==true||!environment.NOVA_PREVIEW_OWNER_EMAIL||String(user.email).toLowerCase()!==environment.NOVA_PREVIEW_OWNER_EMAIL.toLowerCase()||(environment.NOVA_PREVIEW_OWNER_SUBJECT&&user.id!==environment.NOVA_PREVIEW_OWNER_SUBJECT))throw new ConsoleAccessError('console_workspace_forbidden',403);
  return Object.freeze({ownerId:SYNTHETIC_OWNER_ID,workspaceId:SYNTHETIC_OWNER_ID,subject:user.id,role:'owner',issuer:PREVIEW_AUTH_URL});
}
export function createPreviewAuth({environment,serverFactory=createAuthServer,proxy=handleAuthProxyRequest}) {
  // Purpose-separated cache-signing key derived from the isolated database's
  // random credential. No shared Production key or new secret-copy workflow.
  const password=new URL(environment.DATABASE_URL).password;
  const cookieSecret=Buffer.from(hkdfSync('sha256',Buffer.from(password),'nova-preview-auth','session-cache-v1',32)).toString('base64');
  const config={baseUrl:PREVIEW_AUTH_URL,cookieSecret,sessionDataTtl:30,sameSite:'strict',log:silent};
  function server(req,res){
    return serverFactory({...config,context:()=>({
      getCookies:()=>extractNeonAuthCookies(req.headers.cookie||''),
      setCookie:(name,value,options)=>{if(res)res.setHeader('Set-Cookie',[...(res.getHeader('Set-Cookie')||[]),serializeSetCookie({name,value,...options})]);},
      getHeader:name=>req.headers[name.toLowerCase()]||null,
      getOrigin:()=>req.headers.origin||'',getFramework:()=> 'nova-node',
    })});
  }
  const authorize=async req=>{
    if(!req.headers.cookie)throw new ConsoleAccessError('console_identity_required');
    let result;try{result=await server(req).getSession({query:{disableCookieCache:'true'}});}catch{throw new ConsoleAccessError('console_identity_unavailable',503);}
    return workspaceActor(result?.data,environment);
  };
  return {authorize,async handle(req,res){
    const pathname=new URL(req.url,'https://preview.invalid').pathname;
    if(pathname==='/api/preview/isolation'&&req.method==='GET'){
      try{const sql=neon(environment.DATABASE_URL);await assertSyntheticDatabase(statement=>sql.query(statement));json(res,200,{synthetic:true,databaseVerified:true,neonBranch:PREVIEW_NEON_BRANCH,authUrl:PREVIEW_AUTH_URL,gitBranch:environment.VERCEL_GIT_COMMIT_REF,externalActions:false,privatePhone:false,whatsappSending:false});}catch{json(res,503,{error:'Preview isolation verification failed.'});}return true;
    }
    if(pathname==='/api/preview/session'){
      try{const actor=await authorize(req);json(res,200,{workspaceId:actor.workspaceId,synthetic:true,externalActions:false});}catch(e){json(res,e.statusCode||401,{code:e.code||'console_identity_required'});}return true;
    }
    if(!pathname.startsWith('/api/auth/'))return false;
    const path=pathname.slice('/api/auth/'.length);
    if(req.method!=='POST'||!['sign-up/email','sign-in/email','sign-out','email-otp/verify-email','email-otp/send-verification-otp'].includes(path)){json(res,404,{error:'Not found'});return true;}
    const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
    const origin=req.headers.origin;
    try{if(!origin||new URL(origin).host!==host)throw new Error();}catch{json(res,403,{error:'Same-origin request required.'});return true;}
    try{
      const body=await readJsonBody(req,8192);
      if(path!=='sign-out'&&String(body.email||'').toLowerCase()!==String(environment.NOVA_PREVIEW_OWNER_EMAIL||'').toLowerCase()){json(res,403,{error:'This Preview is reserved for its owner account.'});return true;}
      if(path==='email-otp/send-verification-otp')body.type='email-verification';
      // Only local return paths; do not forward arbitrary redirects or plugins.
      delete body.callbackURL;delete body.redirectTo;
      const response=await proxy({...config,path,request:new Request(`${origin}${pathname}`,{method:'POST',headers:{'content-type':'application/json',origin,cookie:extractNeonAuthCookies(req.headers.cookie||'')},body:JSON.stringify(body)})});
      const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
      // Never return the provider's session token, password or raw diagnostics.
      json(res,response.status,{ok:response.ok,...(!response.ok?{error:response.status===403?'Verify your email code before signing in.':'Sign-in could not be completed. Check your details or retry.'}:{})});
    }catch{json(res,503,{error:'Preview sign-in is temporarily unavailable.'});}
    return true;
  }};
}
