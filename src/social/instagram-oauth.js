import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const INSTAGRAM_SCOPES=Object.freeze([
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
]);
export const INSTAGRAM_OAUTH_COOKIE="nova_instagram_oauth_session";
const AUTH_URL="https://www.instagram.com/oauth/authorize";
const TOKEN_URL="https://api.instagram.com/oauth/access_token";
const GRAPH_URL="https://graph.instagram.com";
const EXPECTED_USERNAME="novadigitalservicesuk";
const digest=value=>createHash("sha256").update(value).digest("hex");
const randomToken=bytes=>bytes(32).toString("base64url");
const tokenRecord=payload=>{
  const record=Array.isArray(payload?.data)?payload.data[0]:payload;
  return record&&typeof record==="object"?record:null;
};
const grantedPermissions=value=>{
  const values=Array.isArray(value)?value:typeof value==="string"?value.split(","):null;
  if(!values)throw new InstagramOAuthError("Instagram returned an invalid permission grant.",{code:"instagram_scope_response_invalid",statusCode:502});
  const scopes=[...new Set(values.map(scope=>typeof scope==="string"?scope.trim():"").filter(Boolean))].sort();
  if(!scopes.length)throw new InstagramOAuthError("Instagram returned an invalid permission grant.",{code:"instagram_scope_response_invalid",statusCode:502});
  const missing=INSTAGRAM_SCOPES.filter(scope=>!scopes.includes(scope));
  if(missing.length)throw new InstagramOAuthError("Instagram did not grant all required scopes.",{code:"instagram_scope_missing",statusCode:403,category:"authorization"});
  const unexpected=scopes.filter(scope=>!INSTAGRAM_SCOPES.includes(scope));
  if(unexpected.length)throw new InstagramOAuthError("Instagram returned an unauthorized scope.",{code:"instagram_scope_unexpected",statusCode:403,category:"authorization"});
  return scopes;
};

export class InstagramOAuthError extends Error{
  constructor(message,{code="instagram_oauth_error",statusCode=502,category="provider"}={}){super(message);this.name="InstagramOAuthError";this.code=code;this.statusCode=statusCode;this.category=category;}
}

function cipherFor(value,randomBytesImpl){
  const key=/^[a-f0-9]{64}$/i.test(value||"")?Buffer.from(value,"hex"):Buffer.from(value||"","base64");
  if(key.length!==32)throw new Error("Instagram token encryption requires a 32-byte key.");
  return Object.freeze({
    encrypt(plaintext){const iv=randomBytesImpl(12),cipher=createCipheriv("aes-256-gcm",key,iv),ciphertext=Buffer.concat([cipher.update(plaintext,"utf8"),cipher.final()]);return{version:1,algorithm:"aes-256-gcm",iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};},
    decrypt(envelope){if(envelope?.version!==1||envelope?.algorithm!=="aes-256-gcm")throw new Error("Stored Instagram credential envelope is invalid.");const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.iv,"base64"));decipher.setAuthTag(Buffer.from(envelope.tag,"base64"));return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]).toString("utf8");},
  });
}

export function createInstagramOAuthService({config,storage,ownerId,fetchImpl=globalThis.fetch,clock=()=>new Date(),randomBytesImpl=randomBytes}={}){
  const settings=config.social,oauth=settings.oauth,cipher=oauth.configured?cipherFor(oauth.tokenEncryptionKey,randomBytesImpl):null;
  const requireConfigured=()=>{if(!oauth.configured)throw new InstagramOAuthError("Instagram OAuth is not configured.",{code:"instagram_oauth_not_configured",statusCode:503,category:"configuration"});};
  const request=async(url,options,operation)=>{let response;try{response=await fetchImpl(url,{signal:AbortSignal.timeout(15000),...options});}catch{throw new InstagramOAuthError(`Instagram ${operation} could not be reached.`,{code:"instagram_provider_unavailable",statusCode:503,category:"network"});}const body=await response.json().catch(()=>null);if(!response.ok)throw new InstagramOAuthError(`Instagram ${operation} failed safely.`,{code:"instagram_provider_rejected",statusCode:502});return body;};
  const revoke=async token=>{try{await fetchImpl(`${GRAPH_URL}/me/permissions?${new URLSearchParams({access_token:token})}`,{method:"DELETE",signal:AbortSignal.timeout(10000)});}catch{}}
  const accessToken=async()=>{requireConfigured();const connection=await storage.getInstagramConnection(ownerId);if(!connection)throw new InstagramOAuthError("Instagram must be connected first.",{code:"instagram_not_connected",statusCode:409,category:"authentication"});if(new Date(connection.expiresAt).getTime()<=clock().getTime()+60000)throw new InstagramOAuthError("Instagram access has expired; reconnect is required.",{code:"instagram_reconnect_required",statusCode:409,category:"authentication"});return cipher.decrypt(connection.encryptedAccessToken);};
  return Object.freeze({
    configured:oauth.configured,
    accessToken,
    async status(){const connection=oauth.configured?await storage.getInstagramConnection(ownerId):null;return{configured:oauth.configured,connected:Boolean(connection),accountId:connection?.accountId||null,username:connection?.username||null,scopes:connection?.scopes||INSTAGRAM_SCOPES,connectedAt:connection?.connectedAt||null,expiresAt:connection?.expiresAt||null};},
    async start(){requireConfigured();const state=randomToken(randomBytesImpl),session=randomToken(randomBytesImpl),expiresAt=new Date(clock().getTime()+10*60000).toISOString();await storage.saveInstagramOAuthState({stateHash:digest(state),ownerId,sessionHash:digest(session),expiresAt});const url=new URL(AUTH_URL);url.search=new URLSearchParams({client_id:oauth.appId,redirect_uri:oauth.redirectUri,response_type:"code",scope:INSTAGRAM_SCOPES.join(","),state,enable_fb_login:"0",force_authentication:"1"});return{authorizationUrl:url.toString(),session,expiresAt};},
    async complete({code,state,session}){
      requireConfigured();
      if(![code,state,session].every(value=>typeof value==="string"&&value.length>=8))throw new InstagramOAuthError("Instagram OAuth callback is invalid or expired.",{code:"instagram_oauth_invalid",statusCode:400,category:"validation"});
      const accepted=await storage.consumeInstagramOAuthState({stateHash:digest(state),ownerId,sessionHash:digest(session),consumedAt:clock().toISOString()});
      if(!accepted)throw new InstagramOAuthError("Instagram OAuth state is invalid, expired, or already used.",{code:"instagram_oauth_state_rejected",statusCode:400,category:"csrf"});
      const exchanged=await request(TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:oauth.appId,client_secret:oauth.appSecret,grant_type:"authorization_code",redirect_uri:oauth.redirectUri,code})},"OAuth exchange");
      const short=tokenRecord(exchanged);
      if(typeof short?.access_token!=="string")throw new InstagramOAuthError("Instagram OAuth returned no access token.",{code:"instagram_oauth_exchange_failed"});
      let token=short.access_token,persisted=false;
      try{
        const scopes=grantedPermissions(short.permissions);
        const longResponse=await request(`${GRAPH_URL}/access_token?${new URLSearchParams({grant_type:"ig_exchange_token",client_secret:oauth.appSecret,access_token:token})}`,{},"long-lived token exchange");
        const long=tokenRecord(longResponse);
        if(typeof long?.access_token!=="string")throw new InstagramOAuthError("Instagram long-lived token exchange returned no access token.",{code:"instagram_oauth_exchange_failed"});
        token=long.access_token;
        const expiresIn=Number(long.expires_in||short.expires_in||3600);
        const profile=await request(`${GRAPH_URL}/me?${new URLSearchParams({fields:"id,user_id,username,account_type",access_token:token})}`,{},"identity verification");
        const accountId=String(profile?.user_id||profile?.id||"");
        const username=String(profile?.username||"").toLowerCase();
        if(accountId!==settings.instagramAccountId||username!==EXPECTED_USERNAME)throw new InstagramOAuthError("The authorized Instagram account is not Nova's approved account.",{code:"instagram_wrong_account",statusCode:403,category:"authorization"});
        const expiresAt=new Date(clock().getTime()+expiresIn*1000).toISOString();
        const saved=await storage.saveInstagramConnection({ownerId,accountId,username,scopes,encryptedAccessToken:cipher.encrypt(token),expiresAt});
        persisted=true;
        await storage.appendActivity({ownerId,action:"instagram_connected",status:"completed",summary:"Connected Nova's approved Instagram account.",metadata:{username:saved.username,accountId:saved.accountId,scopes:saved.scopes}});
        return{connected:true,accountId:saved.accountId,username:saved.username,scopes:saved.scopes,expiresAt};
      }catch(error){
        if(persisted){try{await storage.deleteInstagramConnection(ownerId);}catch{}}
        await revoke(token);
        throw error;
      }
    },
    async disconnect(){requireConfigured();const connection=await storage.getInstagramConnection(ownerId);if(!connection)return{connected:false,disconnected:false};let revoked=false;try{const token=cipher.decrypt(connection.encryptedAccessToken);const response=await fetchImpl(`${GRAPH_URL}/me/permissions?${new URLSearchParams({access_token:token})}`,{method:"DELETE",signal:AbortSignal.timeout(10000)});revoked=response.ok;}catch{}await storage.deleteInstagramConnection(ownerId);await storage.appendActivity({ownerId,action:"instagram_disconnected",status:"completed",summary:"Disconnected Nova's Instagram account locally.",metadata:{providerRevocationConfirmed:revoked}});return{connected:false,disconnected:true,providerRevocationConfirmed:revoked};},
  });
}
