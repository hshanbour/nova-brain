import {createHash} from "node:crypto";

const API_ORIGIN="https://api.sender.net";
const FREE_EMAIL_DOMAINS=new Set(["gmail.com","googlemail.com","yahoo.com","outlook.com","hotmail.com","live.com"]);
const PROVIDER_HOSTED_DOMAINS=new Set(["vercel.app"]);
const digest=value=>createHash("sha256").update(String(value)).digest("hex");
const safeId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{2,80}$/.test(value);

export const SHARP_CUTS_SENDER_PLAN=Object.freeze({
  provider:"Sender.net",
  plan:"Professional trial → Free Forever",
  planEvidence:"Sender billing showed an active Professional trial that automatically moves to Free Forever; the campaign is designed against the Free Forever limits only.",
  monthlyCostGbp:0,
  subscriberLimit:2500,
  monthlyEmailLimit:15000,
  senderBrandingRequired:true,
  apiAvailable:true,
  webhooksAvailable:false,
  suppressionMode:"provider_status_polling_before_and_after_campaign",
  displayName:"Sharp Cuts",
  sendingDomain:"sharpcuts.uk",
  fromEmail:"info@sharpcuts.uk",
  accountMailbox:"sharpcuts.luton@gmail.com",
});

export function parseSharpCutsSenderConfig(environment={}){
  const values={
    apiToken:environment.NOVA_SHARP_CUTS_SENDER_API_TOKEN||null,
    groupId:environment.NOVA_SHARP_CUTS_SENDER_GROUP_ID||null,
    sendingDomain:environment.NOVA_SHARP_CUTS_SENDER_DOMAIN?.trim().toLowerCase()||SHARP_CUTS_SENDER_PLAN.sendingDomain,
    fromEmail:environment.NOVA_SHARP_CUTS_SENDER_FROM_EMAIL?.trim().toLowerCase()||SHARP_CUTS_SENDER_PLAN.fromEmail,
  };
  if(values.groupId&&!safeId(values.groupId))throw new Error("NOVA_SHARP_CUTS_SENDER_GROUP_ID is invalid.");
  if(!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(values.sendingDomain))throw new Error("NOVA_SHARP_CUTS_SENDER_DOMAIN must be an owned DNS domain.");
  if(FREE_EMAIL_DOMAINS.has(values.sendingDomain)||[...PROVIDER_HOSTED_DOMAINS].some(domain=>values.sendingDomain===domain||values.sendingDomain.endsWith(`.${domain}`)))throw new Error("Sharp Cuts marketing requires an owned DNS domain; free-mail and provider-hosted domains are not accepted.");
  const match=values.fromEmail.match(/^([^@\s]+)@([^@\s]+)$/);
  if(!match||match[2]!==values.sendingDomain)throw new Error("NOVA_SHARP_CUTS_SENDER_FROM_EMAIL must use the authenticated Sharp Cuts sending domain.");
  if(values.sendingDomain!==SHARP_CUTS_SENDER_PLAN.sendingDomain||values.fromEmail!==SHARP_CUTS_SENDER_PLAN.fromEmail)throw new Error("Sharp Cuts email must use the approved sharpcuts.uk sender identity.");
  const configured=Boolean(values.apiToken);
  return Object.freeze({configured,draftConfigured:configured&&Boolean(values.groupId),liveEnabled:configured&&environment.NOVA_SHARP_CUTS_EMAIL_LIVE_ENABLED==="true",...SHARP_CUTS_SENDER_PLAN,...values,blocker:configured?null:"sender_api_token_required"});
}

export function senderReadiness(config){
  return Object.freeze({
    provider:SHARP_CUTS_SENDER_PLAN.provider,
    plan:SHARP_CUTS_SENDER_PLAN.plan,
    planEvidence:SHARP_CUTS_SENDER_PLAN.planEvidence,
    suitableForCandidateAudience:SHARP_CUTS_SENDER_PLAN.subscriberLimit>=1161,
    displayName:SHARP_CUTS_SENDER_PLAN.displayName,
    configured:config?.configured===true,
    liveEnabled:config?.liveEnabled===true,
    fromEmail:SHARP_CUTS_SENDER_PLAN.fromEmail,
    accountMailbox:SHARP_CUTS_SENDER_PLAN.accountMailbox,
    limits:Object.freeze({subscribers:2500,emailsPerMonth:15000,dailyLimit:null}),
    cost:Object.freeze({currency:"GBP",monthly:0,senderBrandingRequired:true}),
    domain:Object.freeze({required:true,name:SHARP_CUTS_SENDER_PLAN.sendingDomain,status:config?.configured?"configured_provider_probe_required":"dns_prepared_provider_connection_required",gmailAllowedAsFrom:false,vercelAppAllowed:false}),
    suppression:Object.freeze({providerStatusBeforeSend:true,postCampaignPolling:true,realtimeWebhooks:false,reason:"Sender.net webhooks are not included on the free plan."}),
    safeguards:Object.freeze({customerUploadAuthorised:false,campaignDraftAuthorised:false,sendAuthorised:false,automaticSend:false}),
  });
}

function safeProviderError(status){
  const error=new Error("Sender.net request failed safely.");error.name="SenderMarketingError";error.code=status===401?"sender_authentication_required":status===429?"sender_rate_limited":"sender_provider_failed";error.statusCode=status===429?503:502;return error;
}

export function createSenderMarketingClient({config,fetchImpl=globalThis.fetch,timeoutMs=10_000}={}){
  if(!config?.configured)throw new TypeError("Configured Sharp Cuts Sender.net credentials are required.");
  if(typeof fetchImpl!=="function")throw new TypeError("fetchImpl is required.");
  const request=async(path,{method="GET",body,signal}={})=>{
    if(!new Set(["GET","POST"]).has(method)||!/^\/(?:groups(?:\?limit=1)?|campaigns|campaigns\/[A-Za-z0-9_-]{2,80})$/.test(path))throw new Error("Sender.net endpoint is not allowlisted.");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try{
      const response=await fetchImpl(`${API_ORIGIN}/v2${path}`,{method,headers:{Authorization:`Bearer ${config.apiToken}`,Accept:"application/json","Content-Type":"application/json"},signal:combined,...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok)throw safeProviderError(response.status);
      return await response.json();
    }catch(error){if(error?.name==="AbortError")throw Object.assign(new Error("Sender.net request timed out safely."),{name:"SenderMarketingError",code:"sender_timeout",statusCode:503});if(error?.name==="SenderMarketingError")throw error;throw Object.assign(new Error("Sender.net request failed safely."),{name:"SenderMarketingError",code:"sender_transport_failed",statusCode:502});}
    finally{clearTimeout(timer);}
  };
  return Object.freeze({
    async probe(){const data=await request("/groups?limit=1");return Object.freeze({connected:true,provider:"Sender.net",groupCount:Array.isArray(data?.data)?data.data.length:null,tokenExposed:false});},
    async createCampaignDraft(payload,{authority}={}){
      if(!authority||authority.operation!=="create_campaign_draft"||authority.projectId!=="sharp-cuts-web"||authority.audienceSnapshotHash!==payload?.audienceSnapshotHash||authority.copyHash!==payload?.copyHash)throw Object.assign(new Error("Exact owner-authorised campaign-draft authority is required."),{code:"sender_campaign_authority_required",statusCode:403});
      const response=await request("/campaigns",{method:"POST",body:payload.provider});
      return Object.freeze({created:true,campaignId:response?.data?.id||null,status:response?.data?.status||"DRAFT",sent:false});
    },
    async sendCampaign(){throw Object.assign(new Error("Sharp Cuts live email sending is disabled."),{code:"sender_live_send_disabled",statusCode:403});},
  });
}

const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);

export function buildSenderCampaignDraft({review,config,physicalAddress="Sharp Cuts, 57 Cheapside, Luton, United Kingdom"}={}){
  if(!review||review.projectId!=="sharp-cuts-web")throw new TypeError("Sharp Cuts campaign review is required.");
  if(!config?.configured)throw Object.assign(new Error("An authenticated Sharp Cuts sending domain is required."),{code:"sender_domain_required",statusCode:409});
  if(!config?.draftConfigured)throw Object.assign(new Error("A project-isolated Sender.net recipient group is required before a provider draft can be created."),{code:"sender_group_required",statusCode:409});
  if(review.approval?.approveEnabled!==true||review.audience?.verifiedSendableRecipients<1)throw Object.assign(new Error("A verified sendable audience is required before a Sender.net draft can be created."),{code:"sender_audience_not_verified",statusCode:409});
  const paragraphs=String(review.email.body).split(/\n\n+/).map(value=>`<p>${escapeHtml(value)}</p>`).join("");
  const content=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(review.email.subject)}</title></head><body><main><h1>${escapeHtml(review.offer.title)}</h1>${paragraphs}<p>${escapeHtml(physicalAddress)}</p><p><a href="{$unsubscribe_link}">Unsubscribe</a></p></main></body></html>`;
  const provider={title:"Sharp Cuts · 90+ day reopening win-back",subject:review.email.subject,from:"Sharp Cuts",reply_to:config.fromEmail,preheader:review.email.preheader,content_type:"html",google_analytics:0,auto_followup_active:false,groups:[config.groupId],content};
  return Object.freeze({projectId:"sharp-cuts-web",audienceSnapshotHash:review.approval.immutable.audienceSnapshotHash,copyHash:review.approval.immutable.copyHash,provider:Object.freeze(provider),payloadHash:digest(JSON.stringify(provider)),sendEnabled:false});
}
