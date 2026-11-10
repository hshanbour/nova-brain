import {createRemoteJWKSet, jwtVerify} from "jose";

// Deployment access and workload/bypass tokens are NOT application user identity.
// Bind one verified provider subject to this existing workspace. Other subjects
// are denied; do not silently provision them into the owner's data.
export class ConsoleAccessError extends Error {
  constructor(code, statusCode=401) { super("Verified Nova workspace sign-in is required."); this.code=code; this.statusCode=statusCode; }
}
export function createConsoleAccess({environment={}, ownerId, keySet}={}) {
  const issuer=environment.NOVA_CONSOLE_OIDC_ISSUER;
  const audience=environment.NOVA_CONSOLE_OIDC_AUDIENCE;
  const subject=environment.NOVA_CONSOLE_OIDC_OWNER_SUBJECT;
  const jwks=environment.NOVA_CONSOLE_OIDC_JWKS_URL;
  const configured=Boolean(issuer&&audience&&subject&&(jwks||keySet)&&ownerId);
  let keys=keySet;
  if(configured&&!keys) {
    const url=new URL(jwks);
    if(url.protocol!=="https:"||url.username||url.password)throw new Error("Console identity keys require HTTPS.");
    keys=createRemoteJWKSet(url,{timeoutDuration:5000,cooldownDuration:30000});
  }
  return Object.freeze({configured,async authorize(request) {
    if(!configured)throw new ConsoleAccessError("console_identity_not_configured",503);
    const authorization=request.headers?.authorization;
    const token=typeof authorization==="string"&&authorization.startsWith("Bearer ")?authorization.slice(7):request.headers?.["x-vercel-oidc-passport-token"];
    if(typeof token!=="string"||token.length>16000)throw new ConsoleAccessError("console_identity_required");
    let payload;
    try { ({payload}=await jwtVerify(token,keys,{issuer,audience,algorithms:["RS256","ES256"],requiredClaims:["sub","exp","iat"],maxTokenAge:"1h",clockTolerance:5})); }
    catch { throw new ConsoleAccessError("console_identity_invalid"); }
    if(payload.sub!==subject)throw new ConsoleAccessError("console_workspace_forbidden",403);
    return Object.freeze({ownerId,workspaceId:ownerId,subject:payload.sub,issuer,role:"owner"});
  }});
}

// These routes have their own provider-signature/session/worker authentication.
// No broad '/api/integrations' exemption: status pages contain private data.
export function usesServiceAuthentication(pathname,method) {
  if(method==="POST"&&pathname.startsWith("/api/admin/worker/"))return "worker";
  if(method==="POST"&&pathname==="/api/admin/scheduler/social/tick")return "scheduler";
  if(method==="POST"&&pathname.startsWith("/api/internal/phone/gpt-live-round2/"))return "phone";
  if(method==="POST"&&/^\/api\/phone\/bridge\/(session\/start|turn|event)$/.test(pathname))return "phone";
  if(method==="POST"&&/^\/api\/phone\/twilio\/status\/[^/]+$/.test(pathname))return "phone";
  if(["GET","POST"].includes(method)&&["/wa","/api/integrations/sharp-cuts/whatsapp/webhook"].includes(pathname))return "webhook";
  if(method==="POST"&&["/api/integrations/whatsapp/webhook","/api/integrations/whatsapp/status-callback"].includes(pathname))return "webhook";
  return null;
}
