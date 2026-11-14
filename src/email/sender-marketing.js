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
    suitableForCandidateAudience:SHARP_CUTS_SENDER_PLAN.subscriberLimit>=1562,
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
  const code=status===401?"sender_authentication_required":status===403?"sender_account_restricted":status===429?"sender_rate_limited":new Set([400,422]).has(status)?"sender_request_rejected":"sender_provider_failed";
  const message=status===403?"Sender.net denied this operation.":new Set([400,422]).has(status)?"Sender.net rejected this request.":"Sender.net request failed safely.";
  const error=new Error(message);error.name="SenderMarketingError";error.code=code;error.statusCode=status===429?503:502;error.upstreamStatus=Number.isInteger(status)?status:null;return error;
}

export function createSenderMarketingClient({config,fetchImpl=globalThis.fetch,timeoutMs=10_000}={}){
  if(!config?.configured)throw new TypeError("Configured Sharp Cuts Sender.net credentials are required.");
  if(typeof fetchImpl!=="function")throw new TypeError("fetchImpl is required.");
  const request=async(path,{method="GET",body,signal}={})=>{
    const allowed = method==="GET"
      ? /^\/(?:groups(?:\?limit=1)?|subscribers\?page=[1-9][0-9]{0,2}|campaigns|campaigns\/[A-Za-z0-9_-]{2,80}\/(?:emails-sent|errors))$/.test(path)
      : method==="POST" && /^\/(?:subscribers(?:\/groups\/[A-Za-z0-9_-]{2,80})?|campaigns|message\/send)$/.test(path);
    if(!allowed)throw new Error("Sender.net endpoint is not allowlisted.");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try{
      const response=await fetchImpl(`${API_ORIGIN}/v2${path}`,{method,redirect:"error",headers:{Authorization:`Bearer ${config.apiToken}`,Accept:"application/json","Content-Type":"application/json"},signal:combined,...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok)throw safeProviderError(response.status);
      return await response.json();
    }catch(error){if(error?.name==="AbortError")throw Object.assign(new Error("Sender.net request timed out safely."),{name:"SenderMarketingError",code:"sender_timeout",statusCode:503});if(error?.name==="SenderMarketingError")throw error;throw Object.assign(new Error("Sender.net request failed safely."),{name:"SenderMarketingError",code:"sender_transport_failed",statusCode:502});}
    finally{clearTimeout(timer);}
  };
  // Kept private to this client. Raw subscriber records never enter the tool
  // registry, model context, persistent activity or the operator's output.
  const inventory=async()=>{
    const records=[];
    for(let page=1;page<=999;page++){
      const result=await request("/subscribers?page="+page);
      if(!Array.isArray(result.data)||!result.meta||Number(result.meta.current_page)!==page ||
        !Number.isSafeInteger(result.meta.total)||result.meta.total<0||!result.links||!("next" in result.links))throw Error("Incomplete Sender subscriber inventory.");
      records.push(...result.data);
      if(!result.links.next){
        if(records.length!==result.meta.total)throw Error("Sender subscriber total changed during reconciliation.");
        return records;
      }
      if(!result.data.length)break;
    }
    throw Error("Sender inventory could not be completely reconciled.");
  };
  return Object.freeze({
    async reconcileAudience({addresses,sharedAddresses,evidence,membershipHash,approvalHash=null}){
      const {planAudienceTransfer}=await import("./sharp-cuts-audience.js");
      const read=async()=>planAudienceTransfer({addresses,sharedAddresses,evidence,membershipHash,groupId:config.groupId,providerSubscribers:await inventory()});
      const plan=await read();
      if(!approvalHash)return plan.summary;
      if(!safeId(config.groupId)||!plan.summary.eligible||plan.summary.unexpectedGroupMembers||
        approvalHash!==plan.summary.approvalHash)throw Error("The reviewed Sharp Cuts audience or destination is unavailable or has changed.");
      // No automatic retry: a timeout may follow a successful write. A new
      // run reconstructs provider membership before it considers another POST.
      let acknowledged=0;
      try{
        for(const email of plan.create){
          const receipt=await request("/subscribers",{method:"POST",body:{email,groups:[config.groupId],trigger_automation:false}});
          if(receipt.success!==true||!receipt.data?.id)throw Error("Subscriber acknowledgement unavailable.");
          acknowledged++;
        }
        for(let i=0;i<plan.add.length;i+=50){
          const subscribers=plan.add.slice(i,i+50);
          const receipt=await request("/subscribers/groups/"+config.groupId,{method:"POST",body:{subscribers,trigger_automation:false}});
          if(receipt.success!==true)throw Error("Group acknowledgement unavailable.");
          acknowledged+=subscribers.length;
        }
        const after=await read();
        if(after.summary.approvalHash!==approvalHash||after.summary.unexpectedGroupMembers||after.create.length||after.add.length)throw Error("Membership receipts differ.");
        return {...after.summary,status:"membership_verified",contactsTransferred:acknowledged,sent:0};
      }catch{
        return {...plan.summary,status:"provider_outcome_requires_reconciliation",acknowledged,contactsTransferred:null,sent:0};
      }
    },
    async probe(){const data=await request("/groups?limit=1");return Object.freeze({connected:true,provider:"Sender.net",groupCount:Number.isInteger(data?.meta?.total)?data.meta.total:null,groupsOnProbePage:Array.isArray(data?.data)?data.data.length:null,tokenExposed:false});},
    async inspectCampaignReadiness(){
      const groups=await request('/groups'),campaigns=await request('/campaigns');
      const number=value=>Number.isFinite(Number(value))&&value!==null?Number(value):null;
      const rows=Array.isArray(campaigns.data)?campaigns.data:campaigns.data?.id?[campaigns.data]:[];
      const summaries=[];
      for(const item of rows.slice(0,10)){
        if(!safeId(item.id))continue;
        let validation={status:'unavailable'};
        try{const result=await request(`/campaigns/${item.id}/errors`);validation={status:'checked',errors:(result.errors||[]).map(e=>String(e.title||'Unknown provider restriction').slice(0,180)),warnings:(result.warnings||[]).map(e=>String(e.title||'Provider warning').slice(0,180))};}catch(e){validation={status:e.code||'provider_failed'};}
        summaries.push({id:item.id,status:item.status||null,recipientCount:number(item.recipient_count),validation});
      }
      return {source:'Sender API read-only',expectedAudience:1562,groups:(groups.data||[]).map(g=>({id:g.id,title:g.title,total:number(g.recipient_count),active:number(g.active_subscribers),unsubscribed:number(g.unsubscribed_count),bounced:number(g.bounced_count),boundToNova:g.id===config.groupId})),groupsComplete:!groups.links?.next,campaigns:summaries,campaignsComplete:!campaigns.links?.next&&rows.length<=10,sendPermissionVerified:false,contactsChanged:0};
    },
    async createCampaignDraft(payload,{authority}={}){
      if(!authority||authority.operation!=="create_campaign_draft"||authority.projectId!=="sharp-cuts-web"||authority.audienceSnapshotHash!==payload?.audienceSnapshotHash||authority.copyHash!==payload?.copyHash)throw Object.assign(new Error("Exact owner-authorised campaign-draft authority is required."),{code:"sender_campaign_authority_required",statusCode:403});
      const response=await request("/campaigns",{method:"POST",body:payload.provider});
      if(!safeId(response?.data?.id)||String(response.data.status).toUpperCase()!=="DRAFT")
        throw Object.assign(new Error("Sender draft outcome is unconfirmed. Check existing campaigns before retrying."),{code:"sender_draft_requires_reconciliation"});
      return Object.freeze({created:true,campaignId:response.data.id,status:"DRAFT",sent:false});
    },
    async sendOwnerTest({recipient=SHARP_CUTS_SENDER_PLAN.accountMailbox,subject="Nova Sender integration test — no action required"}={}, {authority}={}){
      if(!authority||authority.operation!=="send_owner_test"||authority.projectId!=="sharp-cuts-web"||authority.recipient!==recipient||recipient!==SHARP_CUTS_SENDER_PLAN.accountMailbox)throw Object.assign(new Error("Exact owner-test authority is required."),{code:"sender_test_authority_required",statusCode:403});
      const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><main><h1>Sharp Cuts email connection verified</h1><p>This is a single owner-controlled integration test from Nova Preview.</p><p>No customer list was uploaded and no marketing campaign was sent.</p><p>Sharp Cuts, 57 Cheapside, Luton.</p></main></body></html>';
      const response=await request("/message/send",{method:"POST",body:{from:{email:config.fromEmail,name:SHARP_CUTS_SENDER_PLAN.displayName},to:{email:recipient,name:"Sharp Cuts owner"},subject,text:"Sharp Cuts email connection verified. This is a single owner-controlled integration test from Nova Preview. No customer list was uploaded and no marketing campaign was sent.",html,headers:{charset:"utf-8"}}});
      if(response?.success!==true||typeof response?.emailId!=="string")throw safeProviderError(502);
      return Object.freeze({accepted:true,status:"submitted",provider:"Sender.net",messageId:response.emailId,recipient,customerContacts:0,subscriberUploads:0});
    },
    async campaignStatus(campaignId){if(!safeId(campaignId))throw new TypeError("campaignId is invalid.");const [sent,errors]=await Promise.all([request(`/campaigns/${campaignId}/emails-sent`),request(`/campaigns/${campaignId}/errors`)]);const total=sent?.meta?.total??sent?.data?.total;return Object.freeze({campaignId,sentCount:Number.isFinite(Number(total))&&total!=null?Number(total):!sent?.links?.next&&Array.isArray(sent?.data)?sent.data.length:null,deliveredCount:null,deliveryEvidence:'sent_records_are_not_delivery_receipts',errors:(errors.errors||errors.data||[]).map(item=>({code:String(item?.code||'provider_error'),title:String(item?.title||'Provider restriction').slice(0,180),severity:'error'})),warnings:(errors.warnings||[]).map(item=>String(item.title||'Provider warning').slice(0,180)),recipientDetailsExposed:false});},
    async sendCampaign(){throw Object.assign(new Error("Sharp Cuts live email sending is disabled."),{code:"sender_live_send_disabled",statusCode:403});},
  });
}

const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);

export function previewSenderCopy(copy){
  // Historical Nova drafts contain a clearly marked placeholder. Produce the
  // actual provider template without altering the original reviewed text.
  const body=copy.body.replace(/^Unsubscribe:\s*\[PROVIDER UNSUBSCRIBE LINK REQUIRED BEFORE SEND\]\s*$/gmi,"").trim();
  const booking=String(copy.bookingUrl);
  const link='<a href="'+escapeHtml(booking)+'">Book with the Sharp Cuts team</a>';
  const paragraphs=body.split(/\n\s*\n/).map(p=>'<p>'+escapeHtml(p).replaceAll(escapeHtml(booking),link).replaceAll('\n','<br>')+'</p>').join('');
  const address=body.includes(copy.address)?'':'<p>'+escapeHtml(copy.address)+'</p>';
  const content='<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'+escapeHtml(copy.subject)+'</title></head><body><main>'+paragraphs+(body.includes(booking)?'':'<p>'+link+'</p>')+address+'<p><a href="{$unsubscribe_link}">Unsubscribe</a></p></main></body></html>';
  return {subject:copy.subject,from:'Sharp Cuts',reply_to:SHARP_CUTS_SENDER_PLAN.fromEmail,content_type:'html',auto_followup_active:false,google_analytics:0,content};
}

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
