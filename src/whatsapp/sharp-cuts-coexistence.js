import {createCipheriv,createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from "node:crypto";

const PROJECT_ID="sharp-cuts-web";
const CONVERSATION_PREFIX=`whatsapp_${PROJECT_ID}_`;
const BODY_LIMIT=4096;
const LEASE_MS=120_000;
const STOP=/^\s*(?:stop|unsubscribe|cancel|end|quit)\s*[.!]?\s*$/i;
const VERIFIED_PROFILE=Object.freeze({
  businessName:"Sharp Cuts Gents Barbers",
  address:"57 Cheapside, Luton, LU1 2HN",
  phone:"+44 1582 510565",
  bookingSystem:"Fresha",
  bookingUrl:"https://www.fresha.com/a/sharp-cuts-luton-uk-57-cheapside-p20zttw0",
  limitations:["Do not invent prices, availability, staff schedules, bookings, offers, policies, or opening hours.","Ask a staff member to take over whenever the verified facts do not answer the customer."],
});

export class SharpCutsWhatsAppError extends Error{
  constructor(message,{code="sharp_cuts_whatsapp_error",statusCode=400,category="validation",retryable=false}={}){super(message);this.name="SharpCutsWhatsAppError";this.code=code;this.statusCode=statusCode;this.category=category;this.retryable=retryable;}
}

const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const identityKey=key=>createHmac("sha256",key).update("nova-sharp-cuts-whatsapp-contact-v1").digest();
function encryptContact(value,key){const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",identityKey(key),iv),ciphertext=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return["v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),ciphertext.toString("base64url")].join(".");}
function secureEqual(expected,actual){const left=Buffer.from(String(expected||"")),right=Buffer.from(String(actual||""));return left.length===right.length&&left.length>0&&timingSafeEqual(left,right);}
function e164(value){const digits=String(value||"").replace(/\D/g,"");if(!/^\d{8,15}$/.test(digits))throw new SharpCutsWhatsAppError("The WhatsApp contact identifier is invalid.",{code:"sharp_cuts_whatsapp_contact_invalid"});return`+${digits}`;}
function safeText(value){const text=String(value||"").trim();if(!text||Buffer.byteLength(text)>BODY_LIMIT)throw new SharpCutsWhatsAppError("The WhatsApp text is empty or too large.",{code:"sharp_cuts_whatsapp_text_invalid"});return text;}
function providerId(value){const text=String(value||"").trim();if(!/^[A-Za-z0-9._:-]{8,512}$/.test(text))throw new SharpCutsWhatsAppError("The WhatsApp provider message identifier is invalid.",{code:"sharp_cuts_whatsapp_message_invalid"});return text;}
function changes(payload){return(payload?.entry||[]).flatMap(entry=>entry?.changes||[]).filter(change=>change?.field==="messages"&&change?.value?.messaging_product==="whatsapp").map(change=>change.value);}

export function createSharpCutsWhatsAppCoexistenceService({config,storage,ownerId,novaTurn,logger=console}={}){
  if(!config||!storage||!ownerId||typeof novaTurn!=="function")throw new TypeError("Sharp Cuts WhatsApp dependencies are required.");
  const settings=config.sharpCutsWhatsApp;
  const contactId=number=>createHmac("sha256",settings.identityKeyBytes).update(`${PROJECT_ID}:${number}`).digest("hex");
  const finish=async(claim,patch)=>{const saved=await storage.finishWhatsAppInbound({messageSid:claim.messageSid,ownerId,workerId:claim.leaseOwner,leaseToken:claim.leaseToken,...patch});if(!saved)throw new SharpCutsWhatsAppError("The WhatsApp worker lease was fenced.",{code:"sharp_cuts_whatsapp_lease_stale",statusCode:409,category:"storage",retryable:true});return saved;};
  return Object.freeze({
    async status(){return Object.freeze({projectId:PROJECT_ID,number:"+44 1582 510565",provider:settings.provider||"360dialog_coexistence",configured:settings.configured===true,coexistenceRequired:true,businessAppPreserved:true,receiveEnabled:settings.receiveEnabled===true,mode:settings.mode||"disabled",aiReplyPolicy:"draft_then_owner_review",humanTakeover:"business_app_remains_authoritative",sendEnabled:false,campaignsEnabled:false,spendAuthorisedGbp:0,webhookAuthentication:"provider_custom_bearer_header",projectIsolation:"conversation_and_worker_prefix_enforced",nextAction:settings.configured?"complete_owner_controlled_inbound_test":"complete_official_360dialog_embedded_signup_eligibility_check"});},
    async receive(payload,authorization){
      if(!settings.configured||!settings.receiveEnabled)throw new SharpCutsWhatsAppError("Sharp Cuts WhatsApp inbound processing is not enabled.",{code:"sharp_cuts_whatsapp_not_enabled",statusCode:503,category:"configuration"});
      if(!secureEqual(`Bearer ${settings.webhookToken}`,authorization))throw new SharpCutsWhatsAppError("WhatsApp webhook authentication failed.",{code:"sharp_cuts_whatsapp_webhook_unauthorized",statusCode:401,category:"authorization"});
      let accepted=0,duplicates=0,ignored=0,echoes=0;
      for(const value of changes(payload)){
        if(String(value?.metadata?.phone_number_id||"")!==settings.phoneNumberId)throw new SharpCutsWhatsAppError("The webhook phone identity does not match Sharp Cuts.",{code:"sharp_cuts_whatsapp_target_mismatch",statusCode:403,category:"authorization"});
        for(const echo of value.message_echoes||[]){providerId(echo.id);echoes+=1;await storage.appendActivity({ownerId,projectId:PROJECT_ID,action:"sharp_cuts_whatsapp_business_app_echo",status:"completed",summary:"A staff reply from the preserved WhatsApp Business App was observed.",metadata:{providerMessageHash:hash(echo.id),source:"business_app_echo"}});}
        for(const message of value.messages||[]){
          if(message?.type!=="text"||typeof message?.text?.body!=="string"){ignored+=1;continue;}
          const messageSid=providerId(message.id),from=e164(message.from),text=safeText(message.text.body),personId=contactId(from),conversationId=`${CONVERSATION_PREFIX}${personId.slice(0,32)}`;
          const claimed=await storage.claimWhatsAppInbound({messageSid,ownerId,conversationId,contactId:personId,contactCiphertext:encryptContact(from,settings.identityKeyBytes),bodyHash:hash(text)});
          if(!claimed?.claimed){duplicates+=1;continue;}
          await storage.ensureConversation({id:conversationId,ownerId,title:`Sharp Cuts WhatsApp · ${personId.slice(0,8)}`});
          await storage.appendMessage({id:`whatsapp-user-${hash(messageSid).slice(0,40)}`,conversationId,ownerId,role:"user",content:text});
          accepted+=1;
        }
        for(const status of value.statuses||[]){if(status?.id&&status?.status)await storage.updateWhatsAppOutboundByProviderSid(String(status.id),ownerId,{status:String(status.status).toLowerCase(),errorCode:status.errors?.[0]?.code?String(status.errors[0].code).slice(0,32):null});}
      }
      return{accepted:true,queued:accepted,duplicates,ignored,echoes};
    },
    async processNext({workerId=`sharp-cuts-whatsapp-${randomUUID()}`}={}){
      if(!settings.configured||!settings.receiveEnabled)return{worked:false,reason:"not_enabled"};
      const claim=await storage.claimNextWhatsAppInbound({ownerId,workerId,leaseMs:LEASE_MS,conversationPrefix:CONVERSATION_PREFIX});if(!claim)return{worked:false};
      try{
        const userMessageId=`whatsapp-user-${hash(claim.messageSid).slice(0,40)}`,assistantMessageId=`whatsapp-assistant-${hash(claim.messageSid).slice(0,40)}`,messages=await storage.listMessages(claim.conversationId,ownerId,{limit:100}),userMessage=messages.find(item=>item.id===userMessageId);
        if(!userMessage)throw new SharpCutsWhatsAppError("The queued Sharp Cuts WhatsApp message is missing.",{code:"sharp_cuts_whatsapp_message_missing",statusCode:500,category:"storage",retryable:true});
        if(STOP.test(userMessage.content)){await finish(claim,{status:"opt_out_received",errorCode:null});await storage.appendActivity({ownerId,projectId:PROJECT_ID,action:"sharp_cuts_whatsapp_opt_out_received",status:"completed",summary:"A WhatsApp opt-out was captured and no automated reply was sent.",metadata:{conversationId:claim.conversationId,contactId:claim.contactId}});return{worked:true,status:"opt_out_received",conversationId:claim.conversationId};}
        let assistant=messages.find(item=>item.id===assistantMessageId),runId=claim.runId;
        if(!assistant){const result=await novaTurn({message:userMessage.content,conversationId:claim.conversationId,requestId:`sharp-cuts-whatsapp:${hash(claim.messageSid)}`,userMessageId,assistantMessageId,context:{channel:"whatsapp",projectId:PROJECT_ID,personId:claim.contactId,externalActionsAllowed:false,verifiedBusinessProfile:VERIFIED_PROFILE}});assistant={id:result.id||assistantMessageId,content:safeText(result.message)};runId=result.runId||null;const checkpoint=await storage.checkpointWhatsAppInbound({messageSid:claim.messageSid,ownerId,workerId:claim.leaseOwner,leaseToken:claim.leaseToken,runId,assistantMessageId:assistant.id});if(!checkpoint)throw new SharpCutsWhatsAppError("The WhatsApp worker lease was fenced after drafting.",{code:"sharp_cuts_whatsapp_lease_stale",statusCode:409,category:"storage",retryable:true});}
        await finish(claim,{status:"awaiting_owner_review",runId,assistantMessageId:assistant.id,errorCode:null});
        await storage.appendActivity({ownerId,projectId:PROJECT_ID,runId,action:"sharp_cuts_whatsapp_reply_drafted",status:"completed",summary:"Nova prepared a project-scoped WhatsApp reply for owner review; nothing was sent.",metadata:{conversationId:claim.conversationId,replyHash:hash(assistant.content),sendEnabled:false}});
        return{worked:true,status:"awaiting_owner_review",conversationId:claim.conversationId,replyHash:hash(assistant.content),sent:false};
      }catch(error){if(error?.code==="sharp_cuts_whatsapp_lease_stale")return{worked:true,status:"fenced",errorCode:error.code};const retryable=error?.retryable===true&&claim.attemptCount<3;await finish(claim,{status:retryable?"queued":"failed",errorCode:error?.code||"processing_failed",nextAttemptAt:retryable?new Date(Date.now()+1000*2**(claim.attemptCount-1)).toISOString():null});logger.error("Sharp Cuts WhatsApp processing failed",{code:error?.code||"processing_failed",category:error?.category||"unknown",retryable});return{worked:true,status:retryable?"retrying":"failed",errorCode:error?.code||"processing_failed"};}
    },
  });
}
