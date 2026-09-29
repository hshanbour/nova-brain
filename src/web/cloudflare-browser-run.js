import {createHash} from "node:crypto";
import {lookup as defaultLookup} from "node:dns/promises";
import {isIP} from "node:net";

const API_ROOT="https://api.cloudflare.com/client/v4/accounts";
const SAFE_METHODS=new Set(["GET","HEAD","OPTIONS"]);
const BLOCKED_PROTOCOLS=new Set(["file:","ftp:","data:","javascript:","mailto:","tel:"]);
const BLOCKED_MARKERS=Object.freeze([
  ["captcha_required",/captcha|verify you are human|challenge-platform/i],
  ["authentication_required",/\bsign[ -]?in\b|\blog[ -]?in\b|account required/i],
  ["paywall_detected",/subscribe to continue|subscription required|paywall/i],
]);
const bounded=(value,max=500)=>String(value||"").replace(/Bearer\s+\S+/gi,"Bearer [REDACTED]").replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,"[REDACTED]").replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,"$1=[REDACTED]").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const digest=value=>createHash("sha256").update(String(value||"")).digest("hex");
const hostname=value=>{try{return new URL(value).hostname.toLowerCase();}catch{return"";}};
const publicIp=address=>{if(!isIP(address))return false;const value=address.toLowerCase();if(value.includes(":"))return value!=="::"&&value!=="::1"&&!/^(?:fc|fd|fe[89ab]|ff)/.test(value)&&!value.startsWith("2001:db8");const [a,b,c]=value.split(".").map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===192&&b===0&&c===2)||(a===198&&(b===18||b===19))||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113));};

export class BrowserRunError extends Error{constructor(code,message,safeDiagnostics={}){super(message);this.name="BrowserRunError";this.code=code;this.safeDiagnostics=safeDiagnostics;}}

export async function validateBrowserDestination(value,{allowedDomains,resolveHost=defaultLookup}={}){
  let url;try{url=new URL(value);}catch{throw new BrowserRunError("browser_url_invalid","The browser destination is invalid.");}
  if(BLOCKED_PROTOCOLS.has(url.protocol)||url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443"))throw new BrowserRunError("browser_url_forbidden","Only credential-free public HTTPS destinations on the standard port are allowed.");
  for(const key of url.searchParams.keys())if(/^(?:access_?token|api_?key|auth|authorization|credential|password|secret|signature|sig)$/i.test(key))throw new BrowserRunError("browser_url_forbidden","Credential-bearing browser URLs are not allowed.");
  const domain=url.hostname.toLowerCase().replace(/\.$/,"");
  if(!domain||isIP(domain)||domain==="localhost"||domain.endsWith(".local")||!new Set(allowedDomains||[]).has(domain))throw new BrowserRunError("browser_domain_forbidden","The destination is outside the exact server-approved browser domains.",{domain});
  let records;try{records=await resolveHost(domain,{all:true,verbatim:true});}catch{throw new BrowserRunError("browser_dns_failed","The browser destination could not be resolved.",{domain});}
  if(!records?.length||records.some(record=>!publicIp(record.address)))throw new BrowserRunError("browser_network_forbidden","The browser destination resolved outside the public network boundary.",{domain});
  return url;
}

function normalizeDomains(values){
  const domains=[...new Set((values||[]).map(value=>String(value||"").trim().toLowerCase().replace(/\.$/,"")).filter(value=>/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)))];
  if(!domains.length||domains.length>50)throw new BrowserRunError("browser_domains_invalid","The browser requires one to fifty exact public domains.");
  return domains;
}

function safeObservation(value,index){return Object.freeze({sequence:index+1,type:bounded(value?.type,50)||"observation",domain:bounded(value?.domain,253)||null,title:bounded(value?.title,300)||null,url:bounded(value?.url,1000)||null,summary:bounded(value?.summary,500)||null,contentHash:/^[a-f0-9]{64}$/.test(value?.contentHash||"")?value.contentHash:null});}

export function createCloudflareBrowserRunAdapter({accountId,apiToken,fetchImpl=globalThis.fetch,resolveHost=defaultLookup,connectOverCDP,clock=()=>new Date()}={}){
  if(!accountId||!apiToken||typeof fetchImpl!=="function")throw new Error("Cloudflare Browser Run configuration is required.");
  const connect=connectOverCDP||(async(endpoint,options)=>(await import("playwright-core")).chromium.connectOverCDP(endpoint,options));
  return Object.freeze({
    async run({startUrl,allowedDomains,navigation=null,ttlMs=180000,maxPages=8,maxActions=20,maxScreenshots=3,signal,onProgress}={}){
      const domains=normalizeDomains(allowedDomains),initial=await validateBrowserDestination(startUrl,{allowedDomains:domains,resolveHost});
      if(navigation!==null&&(!navigation||navigation.type!=="follow_link_text"||typeof navigation.label!=="string"||!navigation.label.trim()||navigation.label.trim().length>120))throw new BrowserRunError("browser_navigation_invalid","The browser navigation instruction is invalid.");
      const boundedTtl=Math.max(10_000,Math.min(300_000,Number(ttlMs)||180_000)),started=clock();let sessionId=null,browser=null,context=null,actions=0,pages=0,screenshots=0,deadlineTimer=null;
      const observations=[];const progress=async(phase,summary,metadata={})=>onProgress?.({phase,summary,metadata});
      const sessionUrl=`${API_ROOT}/${encodeURIComponent(accountId)}/browser-rendering/devtools/browser`;
      try{
        signal?.throwIfAborted?.();
        await progress("starting_browser","Starting isolated browser.");
        const response=await fetchImpl(`${sessionUrl}?keep_alive=${boundedTtl}&recording=false&targets=true`,{method:"POST",headers:{Authorization:`Bearer ${apiToken}`,"Content-Type":"application/json"},signal,body:JSON.stringify({guardrails:{allowedDomains:domains}})});
        const payload=await response.json().catch(()=>null);
        if(!response.ok||typeof payload?.sessionId!=="string"||typeof payload?.webSocketDebuggerUrl!=="string")throw new BrowserRunError("browser_session_failed","The isolated browser session could not be created.",{stage:"session_create",status:response.status,providerCode:bounded(payload?.errors?.[0]?.code,80)||null});
        sessionId=payload.sessionId;
        browser=await connect(payload.webSocketDebuggerUrl,{headers:{Authorization:`Bearer ${apiToken}`}});
        context=await browser.newContext({acceptDownloads:false,serviceWorkers:"block",permissions:[]});
        signal?.addEventListener?.("abort",()=>{void context?.close().catch(()=>{});void browser?.close().catch(()=>{});},{once:true});
        deadlineTimer=setTimeout(()=>{void context?.close().catch(()=>{});void browser?.close().catch(()=>{});},boundedTtl);deadlineTimer.unref?.();
        await context.route("**/*",async route=>{const request=route.request();try{if(!SAFE_METHODS.has(request.method().toUpperCase()))return route.abort("blockedbyclient");await validateBrowserDestination(request.url(),{allowedDomains:domains,resolveHost});return route.continue();}catch{return route.abort("blockedbyclient");}});
        const page=await context.newPage();pages+=1;
        page.on("download",download=>void download.cancel().catch(()=>{}));page.on("filechooser",chooser=>void chooser.setFiles([]).catch(()=>{}));page.on("popup",popup=>void popup.close().catch(()=>{}));
        await progress("opening_public_page",`Opening ${initial.hostname}.`,{domain:initial.hostname});
        actions+=1;if(actions>maxActions||pages>maxPages)throw new BrowserRunError("browser_limit_reached","The browser action or page limit was reached.");
        await page.goto(initial.href,{waitUntil:"domcontentloaded",timeout:Math.min(60_000,boundedTtl)});
        let final=await validateBrowserDestination(page.url(),{allowedDomains:domains,resolveHost});
        const inspect=async()=>{await progress("inspecting_rendered_content","Inspecting rendered content.",{domain:final.hostname});actions+=1;if(actions>maxActions)throw new BrowserRunError("browser_limit_reached","The browser action limit was reached.");const extracted=await page.evaluate(()=>({title:document.title||"",text:(document.body?.innerText||"").slice(0,100000),links:[...document.querySelectorAll("a[href]")].slice(0,100).map(node=>({text:(node.innerText||node.getAttribute("aria-label")||"").replace(/\s+/g," ").trim().slice(0,200),href:node.href})),forms:document.forms.length}));const marker=BLOCKED_MARKERS.find(([,pattern])=>pattern.test(`${extracted.title} ${extracted.text.slice(0,5000)}`));if(marker)throw new BrowserRunError(marker[0],`Browser inspection stopped at a ${marker[0].replace(/_/g," ")} boundary.`,{stage:"rendered_inspection",domain:final.hostname});const text=bounded(extracted.text,100000),contentHash=digest(text);observations.push(safeObservation({type:"rendered_content",domain:final.hostname,title:extracted.title,url:final.href,summary:`Inspected ${text.length} visible characters.`,contentHash},observations.length));return{extracted,text,contentHash};};
        let inspected=await inspect();
        if(navigation){
          const label=navigation.label.replace(/\s+/g," ").trim(),matches=inspected.extracted.links.filter(link=>link.text.replace(/\s+/g," ").trim()===label);
          if(!matches.length)throw new BrowserRunError("browser_link_not_found","The requested visible link label was not found.",{stage:"link_resolution",domain:final.hostname});
          const destinations=[...new Set(matches.map(link=>new URL(link.href,final).href))];if(destinations.length!==1)throw new BrowserRunError("browser_link_ambiguous","The requested visible link label resolves to multiple destinations.",{stage:"link_resolution",domain:final.hostname});
          const destination=await validateBrowserDestination(destinations[0],{allowedDomains:domains,resolveHost});
          await progress("navigating_public_page",`Following the exact visible ${bounded(label,80)} link.`,{domain:destination.hostname});actions+=1;pages+=1;if(actions>maxActions||pages>maxPages)throw new BrowserRunError("browser_limit_reached","The browser action or page limit was reached.");
          await page.goto(destination.href,{waitUntil:"domcontentloaded",timeout:Math.min(60_000,boundedTtl)});final=await validateBrowserDestination(page.url(),{allowedDomains:domains,resolveHost});inspected=await inspect();
        }
        return Object.freeze({status:"completed",finalUrl:final.href,domain:final.hostname,title:bounded(inspected.extracted.title,300)||null,text:inspected.text,contentHash:inspected.contentHash,retrievedAt:clock().toISOString(),observations:Object.freeze(observations),usage:Object.freeze({provider:"cloudflare",durationMs:Math.max(0,clock()-started),actions,pages,screenshots}),limits:Object.freeze({ttlMs:boundedTtl,maxActions,maxPages,maxScreenshots}),isolation:Object.freeze({freshSession:true,freshContext:true,recording:false,profileImported:false,downloads:false,uploads:false,serviceWorkers:"blocked",permissions:"denied"})});
      }catch(error){if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException("Browser task cancelled.","AbortError");if(error?.name==="AbortError")throw error;if(error instanceof BrowserRunError)throw error;throw new BrowserRunError("browser_session_failed","The isolated browser session failed safely.",{stage:sessionId?"browser_execution":"session_create",errorType:bounded(error?.name,80)||null});}
      finally{
        clearTimeout(deadlineTimer);
        await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
        if(sessionId)await fetchImpl(`${sessionUrl}/${encodeURIComponent(sessionId)}`,{method:"DELETE",headers:{Authorization:`Bearer ${apiToken}`}}).catch(()=>{});
      }
    },
  });
}

export const BROWSER_RUN_LIMITS=Object.freeze({defaultTtlMs:180000,maxTtlMs:300000,normalActions:20,heavyActions:40,maxPages:8,maxScreenshots:3,maxCrashRetries:1,maxDomains:50});
export const VISUAL_BROWSER_FALLBACK_CONTRACT=Object.freeze({version:1,active:false,maxObservations:3,arbitraryComputerUse:false});
