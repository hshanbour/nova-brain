import {createHash} from "node:crypto";

const clean=(value,max=1000)=>String(value??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const slug=value=>clean(value,120).toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80);
const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const safeUrl=value=>{try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password?url.toString():null;}catch{return null;}};
const repoPattern=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export class ProjectDiscoveryError extends Error{
  constructor(code,message,statusCode=400,diagnostics={}){super(message);this.name="ProjectDiscoveryError";this.code=code;this.statusCode=statusCode;this.safeDiagnostics=diagnostics;}
}

async function jsonRequest(fetchImpl,url,{token,headers={}}={}){
  const response=await fetchImpl(url,{headers:{Accept:"application/json",...(token?{Authorization:`Bearer ${token}`}:{}) ,...headers},signal:AbortSignal.timeout(12_000)});
  if(!response.ok)throw new ProjectDiscoveryError("project_provider_unavailable","An authorised project provider could not be read.",503,{provider:new URL(url).hostname,status:response.status});
  return response.json();
}

const VERCEL_READ_ROUTES=Object.freeze([
  Object.freeze({pathname:/^\/v9\/projects$/,query:new Set(["teamId","limit","until"]),required:["teamId","limit"]}),
  Object.freeze({pathname:/^\/v9\/projects\/[^/]+$/,query:new Set(["teamId"]),required:["teamId"]}),
  Object.freeze({pathname:/^\/v6\/deployments$/,query:new Set(["teamId","projectId","limit"]),required:["teamId","projectId","limit"]}),
]);

export function assertVercelDiscoveryGetUrl(value,{method="GET"}={}){
  let url;try{url=new URL(value);}catch{throw new ProjectDiscoveryError("vercel_discovery_request_forbidden","Nova blocked an invalid Vercel discovery request.",403);}
  const route=VERCEL_READ_ROUTES.find(item=>item.pathname.test(url.pathname)),queryKeys=[...url.searchParams.keys()];
  if(method!=="GET"||url.origin!=="https://api.vercel.com"||url.username||url.password||url.hash||!route||queryKeys.some(key=>!route.query.has(key))||[...route.query].some(key=>url.searchParams.getAll(key).length>1)||route.required.some(key=>!url.searchParams.get(key)))throw new ProjectDiscoveryError("vercel_discovery_request_forbidden","Nova permits only the bounded Vercel project and deployment reads required for discovery.",403);
  return url.toString();
}

async function vercelReadRequest(fetchImpl,url,{token}={}){
  const allowed=assertVercelDiscoveryGetUrl(url),response=await fetchImpl(allowed,{method:"GET",headers:{Accept:"application/json",Authorization:`Bearer ${token}`},redirect:"error",signal:AbortSignal.timeout(12_000)});
  if(!response.ok)throw new ProjectDiscoveryError("project_provider_unavailable","The authorised Vercel project provider could not be read.",503,{provider:"api.vercel.com",status:response.status});
  return response.json();
}

function vercelClient({token,teamId,credentialProvider,fetchImpl}){
  const configured=Boolean(credentialProvider||token&&teamId),credential=async()=>credentialProvider?credentialProvider():token&&teamId?{token,teamId,authMode:"team_access_token"}:null;
  return Object.freeze({configured,
    async list(){const auth=await credential();if(!auth)return[];const projects=[];let until=null;for(let page=0;page<20;page++){const query=new URLSearchParams({teamId:auth.teamId,limit:"100",...(until?{until:String(until)}:{})}),data=await vercelReadRequest(fetchImpl,`https://api.vercel.com/v9/projects?${query}`,{token:auth.token});projects.push(...(data.projects||[]));until=data.pagination?.next??null;if(!until)break;}return projects.map(item=>({provider:"vercel",id:clean(item.id,120),name:clean(item.name,120),framework:clean(item.framework,80)||null,updatedAt:item.updatedAt?new Date(item.updatedAt).toISOString():null})).filter(item=>item.id&&item.name);},
    async inspect(id){const auth=await credential();if(!auth)throw new ProjectDiscoveryError("vercel_discovery_unconfigured","Vercel project discovery is not configured.",503);const query=`teamId=${encodeURIComponent(auth.teamId)}`,project=await vercelReadRequest(fetchImpl,`https://api.vercel.com/v9/projects/${encodeURIComponent(id)}?${query}`,{token:auth.token}),deployments=await vercelReadRequest(fetchImpl,`https://api.vercel.com/v6/deployments?${query}&projectId=${encodeURIComponent(id)}&limit=1`,{token:auth.token}),deployment=(deployments.deployments||[])[0]||null,meta=deployment?.meta||{},repository=clean(meta.githubCommitRepo||project.link?.repo||"",200),owner=clean(meta.githubCommitOrg||project.link?.org||"",100),fullRepository=repoPattern.test(repository)?repository:repoPattern.test(`${owner}/${repository}`)?`${owner}/${repository}`:null;
      return{provider:"vercel",id:clean(project.id,120),name:clean(project.name,120),framework:clean(project.framework,80)||null,updatedAt:project.updatedAt?new Date(project.updatedAt).toISOString():null,latestDeployment:deployment?{id:clean(deployment.uid||deployment.id,120),state:clean(deployment.state||deployment.readyState,40),environment:clean(deployment.target||"preview",40),url:safeUrl(`https://${deployment.url}`),createdAt:deployment.created?new Date(deployment.created).toISOString():null,git:{repository:fullRepository,branch:clean(meta.githubCommitRef,200)||null,commitSha:/^[a-f0-9]{7,40}$/i.test(String(meta.githubCommitSha||""))?meta.githubCommitSha:null,commitMessage:clean(meta.githubCommitMessage,500)||null}}:null,domains:[...new Set([...(project.alias||[]),...(deployment?.alias||[])].map(value=>safeUrl(String(value).startsWith("http")?value:`https://${value}`)).filter(Boolean))].slice(0,20)};
    }
  });
}

function githubClient({token,fetchImpl}){
  const configured=Boolean(token),headers={Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  const get=url=>jsonRequest(fetchImpl,url,{token,headers});
  return Object.freeze({configured,
    async list(){if(!configured)return[];const repos=[];for(let page=1;page<=20;page++){const batch=await get(`https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated&page=${page}`);repos.push(...batch);if(batch.length<100)break;}return repos.map(repo=>({provider:"github",id:clean(repo.full_name,220),name:clean(repo.name,120),private:repo.private===true,defaultBranch:clean(repo.default_branch,200)||null,updatedAt:repo.updated_at||null})).filter(item=>repoPattern.test(item.id));},
    async inspect(repository,ref){if(!configured||!repoPattern.test(repository))throw new ProjectDiscoveryError("github_discovery_unavailable","The linked GitHub repository is not available through the authorised connection.",503);const encoded=repository.split("/").map(encodeURIComponent).join("/"),repo=await get(`https://api.github.com/repos/${encoded}`),root=await get(`https://api.github.com/repos/${encoded}/contents?ref=${encodeURIComponent(ref||repo.default_branch)}`),files=Array.isArray(root)?root.map(item=>({name:clean(item.name,200),path:clean(item.path,500),type:item.type==="dir"?"directory":"file"})).slice(0,200):[],manifests={};
      for(const name of ["package.json","vercel.json",".env.example","README.md"]){if(!files.some(item=>item.path===name&&item.type==="file"))continue;try{const value=await get(`https://api.github.com/repos/${encoded}/contents/${encodeURIComponent(name)}?ref=${encodeURIComponent(ref||repo.default_branch)}`),decoded=value.encoding==="base64"?Buffer.from(value.content||"","base64").toString("utf8"):"";if(name==="package.json"){const parsed=JSON.parse(decoded);manifests[name]={scripts:Object.keys(parsed.scripts||{}).slice(0,30),dependencies:Object.keys(parsed.dependencies||{}).slice(0,100),devDependencies:Object.keys(parsed.devDependencies||{}).slice(0,100),engines:parsed.engines||{}};}else if(name==="vercel.json"){const parsed=JSON.parse(decoded);manifests[name]={version:parsed.version||null,hasBuilds:Array.isArray(parsed.builds)&&parsed.builds.length>0,routeCount:Array.isArray(parsed.routes)?parsed.routes.length:0,rewritesCount:Array.isArray(parsed.rewrites)?parsed.rewrites.length:0};}else if(name===".env.example")manifests[name]={present:true,declaredVariableCount:decoded.split(/\r?\n/).filter(line=>/^[A-Z][A-Z0-9_]*=/.test(line)).length,valuesRead:false};else manifests[name]={present:true,characters:decoded.length};}catch{manifests[name]={present:true,readable:false};}}
      return{provider:"github",id:clean(repo.full_name,220),name:clean(repo.name,120),private:repo.private===true,defaultBranch:clean(repo.default_branch,200)||null,language:clean(repo.language,80)||null,updatedAt:repo.updated_at||null,ref:clean(ref||repo.default_branch,200),files,manifests};
    }
  });
}

const NEON_ID=/^[a-z0-9-]{1,60}$/;
const NEON_READ_ROUTES=Object.freeze([
  Object.freeze({pathname:/^\/api\/v2\/projects$/,query:new Set(["limit","cursor","org_id"]),required:["limit","org_id"]}),
  Object.freeze({pathname:/^\/api\/v2\/projects\/[a-z0-9-]{1,60}\/branches$/,query:new Set(["limit","cursor","sort_by","sort_order"]),required:["limit"]}),
  Object.freeze({pathname:/^\/api\/v2\/projects\/[a-z0-9-]{1,60}\/branches\/[a-z0-9-]{1,60}\/databases$/,query:new Set(),required:[]}),
  Object.freeze({pathname:/^\/api\/v2\/projects\/[a-z0-9-]{1,60}\/branches\/[a-z0-9-]{1,60}\/schema$/,query:new Set(["db_name","format"]),required:["db_name","format"]}),
]);

export function assertNeonDiscoveryGetUrl(value,{method="GET"}={}){
  let url;try{url=new URL(value);}catch{throw new ProjectDiscoveryError("neon_discovery_request_forbidden","Nova blocked an invalid Neon discovery request.",403);}
  const route=NEON_READ_ROUTES.find(item=>item.pathname.test(url.pathname)),queryKeys=[...url.searchParams.keys()];
  const invalidSchema=url.pathname.endsWith("/schema")&&url.searchParams.get("format")!=="json";
  if(method!=="GET"||url.origin!=="https://console.neon.tech"||url.username||url.password||url.hash||!route||invalidSchema||queryKeys.some(key=>!route.query.has(key))||[...route.query].some(key=>url.searchParams.getAll(key).length>1)||route.required.some(key=>!url.searchParams.get(key)))throw new ProjectDiscoveryError("neon_discovery_request_forbidden","Nova permits only bounded Neon project, branch, database, and schema metadata reads.",403);
  return url.toString();
}

async function neonReadRequest(fetchImpl,url,{token}={}){
  const allowed=assertNeonDiscoveryGetUrl(url),response=await fetchImpl(allowed,{method:"GET",headers:{Accept:"application/json",Authorization:`Bearer ${token}`},redirect:"error",signal:AbortSignal.timeout(12_000)});
  if(!response.ok)throw new ProjectDiscoveryError("project_provider_unavailable","The authorised Neon project provider could not be read.",503,{provider:"console.neon.tech",status:response.status});
  const length=Number(response.headers.get("content-length")||0);if(length>2*1024*1024)throw new ProjectDiscoveryError("neon_discovery_response_too_large","Neon metadata exceeded Nova's bounded discovery limit.",502);
  const text=await response.text();if(Buffer.byteLength(text,"utf8")>2*1024*1024)throw new ProjectDiscoveryError("neon_discovery_response_too_large","Neon metadata exceeded Nova's bounded discovery limit.",502);
  try{return JSON.parse(text);}catch{throw new ProjectDiscoveryError("neon_discovery_response_invalid","Neon returned invalid metadata.",502);}
}

function safeSchemaSummary(value,{database}={}){
  const serialized=JSON.stringify(value),tables=new Set(),schemas=new Set();
  const visit=(node,key="")=>{if(!node||typeof node!=="object")return;if(Array.isArray(node)){for(const item of node)visit(item,key);return;}for(const [name,item] of Object.entries(node)){const lowered=name.toLowerCase();if(typeof item==="string"){if(["table","table_name","tablename"].includes(lowered)&&/^[A-Za-z_][A-Za-z0-9_$.-]{0,127}$/.test(item))tables.add(clean(item,128));if(["schema","schema_name","schemaname"].includes(lowered)&&/^[A-Za-z_][A-Za-z0-9_$.-]{0,127}$/.test(item))schemas.add(clean(item,128));}visit(item,name);}};
  visit(value);
  return Object.freeze({database:clean(database,120),contentHash:hash(serialized),tableCount:tables.size,tables:[...tables].sort().slice(0,250),schemaCount:schemas.size,schemas:[...schemas].sort().slice(0,50),rowsRead:false,connectionStringRead:false,rawSchemaRetained:false});
}

function neonClient({apiKey,orgId,fetchImpl}){
  const configured=Boolean(apiKey&&orgId),get=url=>neonReadRequest(fetchImpl,url,{token:apiKey});
  async function list(){if(!configured)return[];const projects=[];let cursor=null;for(let page=0;page<20;page++){const query=new URLSearchParams({limit:"100",org_id:orgId,...(cursor?{cursor}:{})}),data=await get(`https://console.neon.tech/api/v2/projects?${query}`);projects.push(...(data.projects||[]));cursor=data.pagination?.next||null;if(!cursor)break;}return projects.map(project=>({provider:"neon",id:clean(project.id,120),name:clean(project.name,160),region:clean(project.region_id||project.region,80)||null,updatedAt:project.updated_at||null,creationSource:clean(project.creation_source,80)||null})).filter(item=>NEON_ID.test(item.id)&&item.name);}
  async function inspect(projectId){if(!configured||!NEON_ID.test(projectId))throw new ProjectDiscoveryError("neon_discovery_target_invalid","Choose one authorised Neon project.",400);const query=new URLSearchParams({limit:"100",sort_by:"updated_at",sort_order:"desc"}),data=await get(`https://console.neon.tech/api/v2/projects/${projectId}/branches?${query}`),branches=data.branches||[],selected=[...branches.filter(branch=>branch.default===true||branch.primary===true),...branches].filter((branch,index,array)=>array.findIndex(item=>item.id===branch.id)===index).slice(0,5),safeBranches=[];for(const branch of selected){const branchId=clean(branch.id,120);if(!NEON_ID.test(branchId))continue;const databaseData=await get(`https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}/databases`),databases=[];for(const database of (databaseData.databases||[]).slice(0,20)){const name=clean(database.name,120);if(!name)continue;let schema=null;try{const schemaQuery=new URLSearchParams({db_name:name,format:"json"}),schemaData=await get(`https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}/schema?${schemaQuery}`);schema=safeSchemaSummary(schemaData,{database:name});}catch(error){schema={database:name,available:false,errorCode:error.code||"neon_schema_unavailable",rowsRead:false,connectionStringRead:false};}databases.push({name,owner:clean(database.owner_name,120)||null,schema});}safeBranches.push({id:branchId,name:clean(branch.name,160),default:branch.default===true||branch.primary===true,parentId:NEON_ID.test(String(branch.parent_id||""))?branch.parent_id:null,updatedAt:branch.updated_at||null,databases});}
    return{provider:"neon",id:projectId,branches:safeBranches,permissions:{providerCredential:"organisation-bound API key",applicationOperations:["GET projects","GET branches","GET databases","GET schema"],executionGranted:false,rowsRead:false,connectionStringsRead:false}};
  }
  return Object.freeze({configured,list,inspect});
}

export function createProjectDiscoveryProviders({config,vercelAccountIntegration,fetchImpl=globalThis.fetch}={}){
  return Object.freeze({
    vercel:vercelClient({token:config?.vercelToken,teamId:config?.vercelTeamId,credentialProvider:vercelAccountIntegration?()=>vercelAccountIntegration.credential():null,fetchImpl}),
    github:githubClient({token:config?.githubToken,fetchImpl}),
    neon:neonClient({apiKey:config?.neonApiKey,orgId:config?.neonOrgId,fetchImpl}),
  });
}

function similarity(name,target){const a=new Set(slug(name).split("-").filter(Boolean)),b=new Set(slug(target).split("-").filter(Boolean));return[...a].filter(value=>b.has(value)).length/Math.max(a.size,b.size,1);}
function projectFacts(snapshot){const facts=[`The authorised Vercel project is ${snapshot.vercel.name} (${snapshot.vercel.id}).`];const deployment=snapshot.vercel.latestDeployment;if(deployment){facts.push(`Its latest Vercel deployment is ${deployment.state} in ${deployment.environment} at ${deployment.url||"an unavailable URL"}.`);if(deployment.git?.repository)facts.push(`That deployment is linked to GitHub repository ${deployment.git.repository}${deployment.git.commitSha?` at commit ${deployment.git.commitSha}`:""}.`);}if(snapshot.github){const packageData=snapshot.github.manifests?.["package.json"];facts.push(`The linked repository is ${snapshot.github.private?"private":"public"}, with default branch ${snapshot.github.defaultBranch||"unknown"}.`);if(packageData?.dependencies?.length)facts.push(`The repository declares these runtime packages: ${packageData.dependencies.join(", ")}.`);if(snapshot.github.files?.length)facts.push(`The repository root contains: ${snapshot.github.files.slice(0,30).map(item=>item.path).join(", ")}.`);}if(snapshot.website?.status==="completed")facts.push(`The deployed website presented the title ${snapshot.website.title||"(no title)"} when read at ${snapshot.website.url}.`);return facts;}

export function createProjectDiscoveryService({providers,projectService,projectOnboarding,storage,ownerId,pageReader,connectionStatus,clock=()=>new Date()}={}){
  if(!providers||!projectService||!projectOnboarding||!storage||!ownerId)throw new Error("Project discovery requires providers, projects, onboarding, storage, and an owner.");
  async function catalog(){const status={};const assets={};for(const name of ["vercel","github","neon"]){status[name]={configured:providers[name]?.configured===true};if(!status[name].configured){assets[name]=[];continue;}try{assets[name]=await providers[name].list();status[name].available=true;}catch(error){assets[name]=[];status[name]={...status[name],available:false,errorCode:error.code||"project_provider_unavailable"};}}if(connectionStatus){status.vercel={...status.vercel,...await connectionStatus()};if(status.vercel.authMode==="none"){status.vercel.configured=false;status.vercel.available=false;assets.vercel=[];}}return{status,assets,policy:{discovery:"read_only",knowledgeIngestion:"owner_review_required",execution:"not_granted",crossProviderAuthorization:"independent"}};}
  async function inspect({provider="vercel",assetId}={}){
    if(provider!=="vercel"||!assetId)throw new ProjectDiscoveryError("project_discovery_target_invalid","Choose one authorised Vercel project.");
    const vercel=await providers.vercel.inspect(clean(assetId,120)),deployment=vercel.latestDeployment,repository=deployment?.git?.repository||null;
    let github=null;if(repository&&providers.github?.configured)try{github=await providers.github.inspect(repository,deployment.git.commitSha||deployment.git.branch);}catch{/* represented below as missing */}
    let website=null;const websiteUrl=vercel.domains[0]||deployment?.url;if(websiteUrl&&pageReader)try{const value=await pageReader.read(websiteUrl);website=value.status==="completed"?{status:"completed",url:value.url,title:clean(value.title,300)||null,contentHash:value.contentHash,retrievedAt:value.retrievedAt,excerpt:clean(value.text,1800)}:{status:value.status,limitation:clean(value.limitation,200)};}catch{website={status:"unavailable"};}
    let neon=[];if(providers.neon?.configured)try{const candidates=(await providers.neon.list()).filter(item=>similarity(item.name,vercel.name)>=0.5);for(const item of candidates){let metadata=null;try{metadata=await providers.neon.inspect(item.id);}catch{/* candidate remains reviewable without schema metadata */}const branchCount=metadata?.branches?.length||0,databaseCount=metadata?.branches?.reduce((total,branch)=>total+branch.databases.length,0)||0,tableNames=[...new Set((metadata?.branches||[]).flatMap(branch=>branch.databases.flatMap(database=>database.schema?.tables||[])))].slice(0,250);neon.push({...item,relationship:"possible_metadata_match",confirmed:false,evidence:{nameSimilarity:Number(similarity(item.name,vercel.name).toFixed(3)),branchCount,databaseCount,tableCount:tableNames.length,tables:tableNames,rowsRead:false,connectionStringRead:false},metadata});}}catch{/* provider status remains visible in catalog */}
    const existing=(await storage.listProjects(ownerId)).filter(item=>similarity(item.name,vercel.name)>=0.5).map(item=>({id:item.id,name:item.name,match:item.id===slug(vercel.name)?"exact_identity":"similar_name_only"}));
    const snapshot={version:1,inspectedAt:clock().toISOString(),vercel,github,website,neon};const facts=projectFacts(snapshot),questions=[];
    if(!github)questions.push(repository?"Confirm that Nova's GitHub authorization includes the linked repository.":"Confirm which GitHub repository, if any, is authoritative for this Vercel project.");
    if(neon.length)questions.push(`Confirm whether ${neon.map(item=>item.name).join(", ")} is the database for this project; project names and schema metadata narrow the candidates but do not prove the deployment credential binding.`);else questions.push("Confirm whether this project uses a database and, if so, which authorised database is authoritative.");
    questions.push("Confirm the business purpose, current operational status, and any private integrations that cannot be proven from read-only provider metadata.");
    return{snapshotId:`inspection-${hash(JSON.stringify(snapshot)).slice(0,32)}`,suggestedProject:{id:slug(vercel.name),name:vercel.name.split("-").map(word=>word&&word[0].toUpperCase()+word.slice(1)).join(" "),description:`Imported read-only from authorised Vercel project ${vercel.name}.`},facts,connections:{vercel:{status:"confirmed",id:vercel.id,name:vercel.name},github:github?{status:"confirmed",repository:github.id,ref:github.ref}:{status:"missing_or_unavailable"},neon:neon.map(item=>({status:"possible",id:item.id,name:item.name,reason:"metadata_match_requires_owner_confirmation",evidence:item.evidence}))},missingInformation:questions,existingProjects:existing,snapshot};
  }
  async function importProject({provider="vercel",assetId,projectId,projectName}={}){
    const result=await inspect({provider,assetId}),expectedId=slug(result.snapshot.vercel.name),chosenId=clean(projectId||expectedId,80).toLowerCase();
    if(chosenId!==expectedId)throw new ProjectDiscoveryError("project_import_identity_mismatch","The Nova project ID must exactly match the selected Vercel project identity.",409,{expectedProjectId:expectedId});
    const created=await projectService.create({id:chosenId,name:clean(projectName||result.suggestedProject.name,120),description:result.suggestedProject.description});
    const retained=[];retained.push(await projectOnboarding.retainProviderSnapshot({projectId:chosenId,sourceType:"vercel",label:`Vercel project ${result.snapshot.vercel.name}`,locator:"https://vercel.com/",snapshot:result.snapshot.vercel,facts:result.facts.filter(value=>/Vercel|deployment/i.test(value)),retrievedAt:result.snapshot.inspectedAt}));
    if(result.snapshot.github)retained.push(await projectOnboarding.retainProviderSnapshot({projectId:chosenId,sourceType:"github",label:`GitHub repository ${result.snapshot.github.id}`,locator:`https://github.com/${result.snapshot.github.id}`,snapshot:result.snapshot.github,facts:result.facts.filter(value=>/repository|packages|root contains/i.test(value)),retrievedAt:result.snapshot.inspectedAt}));
    if(result.snapshot.website?.status==="completed")retained.push(await projectOnboarding.retainProviderSnapshot({projectId:chosenId,sourceType:"public_url",label:`Deployed website ${result.snapshot.website.title||result.snapshot.vercel.name}`,locator:result.snapshot.website.url,snapshot:result.snapshot.website,facts:result.facts.filter(value=>/website/i.test(value)),retrievedAt:result.snapshot.website.retrievedAt}));
    if(result.snapshot.neon.length)retained.push(await projectOnboarding.retainProviderSnapshot({projectId:chosenId,sourceType:"neon",label:"Possible Neon connection (owner confirmation required)",locator:"https://console.neon.tech/",snapshot:{candidates:result.snapshot.neon},facts:[],questions:result.missingInformation.filter(value=>/database|Neon/i.test(value)),retrievedAt:result.snapshot.inspectedAt,classification:"possible_connection"}));
    if(result.missingInformation.length)retained.push(await projectOnboarding.retainProviderSnapshot({projectId:chosenId,sourceType:"owner_statement",label:"Onboarding questions",snapshot:{questions:result.missingInformation},facts:[],questions:result.missingInformation,retrievedAt:result.snapshot.inspectedAt,classification:"unresolved_questions"}));
    await storage.appendActivity({ownerId,projectId:chosenId,runId:null,action:"project_provider_import_completed",tool:"project_discovery",status:"completed",summary:`Imported a fresh read-only snapshot of ${result.snapshot.vercel.name}; all discovered knowledge still requires owner review.`,metadata:{provider,assetId:result.snapshot.vercel.id,created:created.created,sourceIds:retained.map(item=>item.source.id),automaticPromotion:false}});
    return{project:created.project,created:created.created,inspection:result,retainedSources:retained.map(item=>item.source),pendingCandidates:retained.flatMap(item=>item.candidates),automaticPromotion:false};
  }
  return Object.freeze({catalog,inspect,importProject});
}
