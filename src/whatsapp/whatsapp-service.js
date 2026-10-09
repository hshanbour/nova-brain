import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

const MESSAGE_SID = /^(?:SM|MM)[a-fA-F0-9]{32}$/;
const WHATSAPP_ADDRESS = /^whatsapp:(\+[1-9]\d{7,14})$/;
const BODY_LIMIT = 4096;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 120_000;

export class WhatsAppError extends Error {
  constructor(message, { code = "whatsapp_error", statusCode = 400, category = "validation", retryable = false } = {}) {
    super(message); this.name = "WhatsAppError"; this.code = code; this.statusCode = statusCode; this.category = category; this.retryable = retryable;
  }
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const contactKey = (key) => createHmac("sha256", key).update("nova-whatsapp-contact-encryption-v1").digest();
function encryptContact(value, key) { const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",contactKey(key),iv),ciphertext=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return ["v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),ciphertext.toString("base64url")].join("."); }
function decryptContact(value, key) { try { const [version,iv,tag,ciphertext]=String(value||"").split(".");if(version!=="v1"||!iv||!tag||!ciphertext)throw new Error("invalid");const decipher=createDecipheriv("aes-256-gcm",contactKey(key),Buffer.from(iv,"base64url"));decipher.setAuthTag(Buffer.from(tag,"base64url"));return Buffer.concat([decipher.update(Buffer.from(ciphertext,"base64url")),decipher.final()]).toString("utf8"); } catch { throw new WhatsAppError("The persisted WhatsApp contact binding is invalid.",{code:"whatsapp_contact_binding_invalid",statusCode:500,category:"storage"}); } }
function address(value,field){const match=String(value||"").match(WHATSAPP_ADDRESS);if(!match)throw new WhatsAppError(`${field} must be a WhatsApp E.164 address.`,{code:"whatsapp_input_invalid"});return match[1];}
function body(value){const text=String(value||"").trim();if(!text||Buffer.byteLength(text)>BODY_LIMIT)throw new WhatsAppError("WhatsApp message body is empty or too large.",{code:"whatsapp_input_invalid"});return text;}
function sid(value,field="MessageSid"){if(!MESSAGE_SID.test(String(value||"")))throw new WhatsAppError(`${field} is invalid.`,{code:"whatsapp_input_invalid"});return String(value);}
function safeReply(value){const text=String(value||"").trim();if(!text)throw new WhatsAppError("Nova produced no WhatsApp reply.",{code:"whatsapp_reply_empty",statusCode:502,category:"agent",retryable:true});return text.slice(0,BODY_LIMIT);}

export function createWhatsAppService({config,storage,ownerId,novaTurn,fetchImpl=globalThis.fetch,logger=console,clock=()=>new Date()}={}){
  if(!config||!storage||!ownerId||typeof novaTurn!=="function")throw new TypeError("WhatsApp service dependencies are required.");
  const settings=config.whatsapp,contactId=number=>createHmac("sha256",settings.identityKeyBytes).update(number).digest("hex");
  const status=async()=>({configured:settings.configured,liveEnabled:settings.liveEnabled,sender:settings.configured?`whatsapp:${settings.number.slice(0,4)}…${settings.number.slice(-3)}`:null,provider:"twilio",processing:"durable_worker",storage:storage.durable?"durable":"ephemeral"});

  async function send({to,text,inboundSid}){
    const claimed=await storage.claimWhatsAppOutbound({ownerId,inboundSid,bodyHash:digest(text)});
    if(!claimed.claimed){if(claimed.message.status==="sending"){await storage.updateWhatsAppOutbound(inboundSid,ownerId,{status:"uncertain",errorCode:"stale_sending"});throw new WhatsAppError("WhatsApp delivery outcome is uncertain; Nova will not retry automatically.",{code:"whatsapp_send_uncertain",statusCode:502,category:"provider"});}return claimed.message;}
    const parameters=new URLSearchParams({To:`whatsapp:${to}`,From:`whatsapp:${settings.number}`,Body:text,StatusCallback:`${settings.publicBaseUrl}api/integrations/whatsapp/status-callback`});let response;
    try{response=await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`,{method:"POST",headers:{authorization:`Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`,"content-type":"application/x-www-form-urlencoded"},body:parameters.toString()});}
    catch{await storage.updateWhatsAppOutbound(inboundSid,ownerId,{status:"uncertain",errorCode:"network_error"});throw new WhatsAppError("WhatsApp delivery outcome is uncertain; Nova will not retry automatically.",{code:"whatsapp_send_uncertain",statusCode:502,category:"provider"});}
    const value=await response.json().catch(()=>({}));if(!response.ok||!MESSAGE_SID.test(String(value.sid||""))){await storage.updateWhatsAppOutbound(inboundSid,ownerId,{status:"failed",errorCode:`twilio_${response.status}`});throw new WhatsAppError("Twilio rejected the WhatsApp reply.",{code:"whatsapp_provider_rejected",statusCode:502,category:"provider"});}
    return storage.updateWhatsAppOutbound(inboundSid,ownerId,{status:"submitted",providerMessageSid:value.sid});
  }
  async function finish(claim,patch){const result=await storage.finishWhatsAppInbound({messageSid:claim.messageSid,ownerId,workerId:claim.leaseOwner,leaseToken:claim.leaseToken,...patch});if(!result)throw new WhatsAppError("The WhatsApp worker lease was fenced.",{code:"whatsapp_lease_stale",statusCode:409,category:"storage",retryable:true});return result;}

  return Object.freeze({
    status,
    async receive(form){
      if(!settings.configured||!settings.liveEnabled)throw new WhatsAppError("Nova WhatsApp live processing is not enabled.",{code:"whatsapp_not_enabled",statusCode:503,category:"configuration"});
      const messageSid=sid(form.MessageSid);if(String(form.NumMedia||"0")!=="0")throw new WhatsAppError("WhatsApp media attachments are not enabled in this bounded release.",{code:"whatsapp_media_unsupported",statusCode:415});
      const from=address(form.From,"From"),to=address(form.To,"To");if(to!==settings.number)throw new WhatsAppError("The WhatsApp webhook target does not match Nova's configured sender.",{code:"whatsapp_target_mismatch",statusCode:403,category:"authorization"});
      const text=body(form.Body),personId=contactId(from),conversationId=`whatsapp_${personId.slice(0,32)}`;
      await storage.ensureConversation({id:conversationId,ownerId,title:`WhatsApp · ${personId.slice(0,8)}`});
      await storage.appendMessage({id:`whatsapp-user-${messageSid}`,conversationId,ownerId,role:"user",content:text});
      const claim=await storage.claimWhatsAppInbound({messageSid,ownerId,conversationId,contactId:personId,contactCiphertext:encryptContact(from,settings.identityKeyBytes),bodyHash:digest(text)});
      return{accepted:true,duplicate:!claim.claimed,messageSid,conversationId,status:claim.message.status};
    },
    async processNext({workerId=`whatsapp-${randomUUID()}`}={}){
      if(!settings.configured||!settings.liveEnabled)return{worked:false,reason:"not_enabled"};
      const claim=await storage.claimNextWhatsAppInbound({ownerId,workerId,leaseMs:LEASE_MS});if(!claim)return{worked:false};
      try{
        const userMessageId=`whatsapp-user-${claim.messageSid}`,assistantMessageId=`whatsapp-assistant-${claim.messageSid}`,messages=await storage.listMessages(claim.conversationId,ownerId,{limit:100}),userMessage=messages.find(item=>item.id===userMessageId);
        if(!userMessage)throw new WhatsAppError("The durable inbound WhatsApp message is missing.",{code:"whatsapp_message_missing",statusCode:500,category:"storage",retryable:true});
        let assistant=messages.find(item=>item.id===assistantMessageId),runId=claim.runId;
        if(!assistant){const result=await novaTurn({message:userMessage.content,conversationId:claim.conversationId,requestId:`whatsapp:${claim.messageSid}`,userMessageId,assistantMessageId,context:{channel:"whatsapp",personId:claim.contactId,externalActionsAllowed:false}});assistant={id:result.id||assistantMessageId,content:safeReply(result.message)};runId=result.runId||null;const checkpoint=await storage.checkpointWhatsAppInbound({messageSid:claim.messageSid,ownerId,workerId:claim.leaseOwner,leaseToken:claim.leaseToken,runId,assistantMessageId:assistant.id});if(!checkpoint)throw new WhatsAppError("The WhatsApp worker lease was fenced after generation.",{code:"whatsapp_lease_stale",statusCode:409,category:"storage",retryable:true});}
        const renewed=await storage.renewWhatsAppInboundLease({messageSid:claim.messageSid,ownerId,workerId:claim.leaseOwner,leaseToken:claim.leaseToken,leaseMs:LEASE_MS});if(!renewed)throw new WhatsAppError("The WhatsApp worker lease was fenced before provider submission.",{code:"whatsapp_lease_stale",statusCode:409,category:"storage",retryable:true});
        const reply=safeReply(assistant.content),to=decryptContact(claim.contactCiphertext,settings.identityKeyBytes),outbound=await send({to,text:reply,inboundSid:claim.messageSid});
        await finish(claim,{status:"replied",runId,assistantMessageId:assistant.id,errorCode:null});
        await storage.appendActivity({ownerId,runId,action:"whatsapp_reply_submitted",status:"completed",summary:"Nova submitted one reply to an authenticated inbound WhatsApp message.",metadata:{conversationId:claim.conversationId,inboundMessageSid:claim.messageSid,outboundStatus:outbound.status}});
        return{worked:true,messageSid:claim.messageSid,conversationId:claim.conversationId,status:"replied"};
      }catch(error){if(error?.code==="whatsapp_lease_stale")return{worked:true,messageSid:claim.messageSid,status:"fenced",errorCode:error.code};const retryable=error?.retryable===true&&claim.attemptCount<MAX_ATTEMPTS;await finish(claim,{status:retryable?"queued":"failed",errorCode:error?.code||"processing_failed",nextAttemptAt:retryable?new Date(clock().getTime()+1000*2**(claim.attemptCount-1)).toISOString():null});logger.error("Nova WhatsApp processing failed",{code:error?.code||"processing_failed",category:error?.category||"unknown",retryable});return{worked:true,messageSid:claim.messageSid,status:retryable?"retrying":"failed",errorCode:error?.code||"processing_failed"};}
    },
    async delivery(form){if(!settings.configured)throw new WhatsAppError("Nova WhatsApp is not configured.",{code:"whatsapp_not_configured",statusCode:503,category:"configuration"});const providerMessageSid=sid(form.MessageSid),providerStatus=String(form.MessageStatus||"").toLowerCase();if(!new Set(["queued","sent","delivered","read","undelivered","failed"]).has(providerStatus))throw new WhatsAppError("MessageStatus is invalid.",{code:"whatsapp_input_invalid"});const updated=await storage.updateWhatsAppOutboundByProviderSid(providerMessageSid,ownerId,{status:providerStatus,errorCode:form.ErrorCode?String(form.ErrorCode).slice(0,32):null});return{accepted:true,matched:Boolean(updated),status:providerStatus};},
  });
}
