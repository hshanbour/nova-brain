import {createHash} from 'node:crypto';
import {RISK_LEVELS} from '../policy/action-policy.js';

// The source is created by the existing authenticated discovery/import flow.
// Neither similar names nor model-supplied Vercel IDs select an external asset.
function authenticatedVercelAsset(source, ownerId, projectId) {
  if(source.ownerId !== ownerId || source.projectId !== projectId || source.sourceType !== 'vercel' ||
     source.status !== 'active' || source.revokedAt || source.accessMode !== 'read_only' ||
     source.permissions?.externalAccess !== true || source.permissions?.readOnly !== true ||
     source.extractionMetadata?.providerAuthenticated !== true ||
     source.extractionMetadata?.classification !== 'confirmed_provider_metadata' ||
     typeof source.extractedText !== 'string') return null;
  if(createHash('sha256').update(source.extractedText.normalize('NFKC')).digest('hex') !== source.contentHash) return null;
  try {
    const snapshot = JSON.parse(source.extractedText);
    return snapshot.provider === 'vercel' && /^prj_[a-zA-Z0-9]+$/.test(snapshot.id) ? snapshot.id : null;
  } catch { return null; }
}

export function requestsDeploymentStatus(message) {
  const query = String(message || '');
  if(/\b(?:do not|don't|never|without)\s+(?:\w+\s+){0,2}(?:check|read|search|inspect)|(?:لا|بدون)\s*(?:تفحص|تتحقق|تفقد|تراجع|فحص|مراجعة|الرجوع)/iu.test(query)) return false;
  return /\b(?:deployment|deployment[s]? status|vercel|deployed commit)\b|فيرسل|فيرسيل|حالة النشر|آخر نشر|اخر نشر/iu.test(query) &&
    /\b(?:latest|current|status|now|check|which commit|what commit)|حالة|آخر|اخر|الآن|هسه|حالي|حاليا|تحقق/iu.test(query);
}

export function registerProjectDeploymentRead(registry,{storage,ownerId,vercel}) {
  registry.register({
    name:'project_deployment_read',category:'projects',capability:'read',riskLevel:RISK_LEVELS.READ_ONLY,
    description:'Check the current Vercel deployment of the exact authorised Nova project. Use for latest environment, commit or deployment status. Saved knowledge cannot establish current deployment status.',
    available:Boolean(vercel?.inspect && storage.listProjectSources),configurationStatus:vercel?.configured?'ready':'binding_required',
    inputSchema:{type:'object',properties:{projectId:{type:'string'}},required:['projectId'],additionalProperties:false},
    async execute({projectId},context) {
      if(typeof projectId !== 'string' || !projectId.trim() || projectId.length > 100 ||
         (context?.projectId && context.projectId !== projectId) ||
         !(await storage.listProjects(ownerId)).some(project => project.id === projectId)) throw Error('Project is outside the selected scope.');
      const records = await storage.listProjectSources(ownerId,{projectId,status:'active',limit:100});
      const ids = new Set(records.map(source => authenticatedVercelAsset(source,ownerId,projectId)).filter(Boolean));
      const unavailable = reason => ({projectId,verification:'unavailable',reason,sources:[]});
      if(!ids.size) return unavailable('No active authenticated Vercel source is bound to this project.');
      if(ids.size !== 1) return unavailable('Conflicting Vercel asset bindings require review.');
      const [assetId] = ids;
      let asset;
      try { asset = await vercel.inspect(assetId); }
      catch { return unavailable('The current Vercel deployment could not be read with the existing connection.'); }
      if(asset?.id !== assetId) return unavailable('The provider returned a different project.');
      const retrievedAt = new Date().toISOString();
      const deployment = asset.latestDeployment;
      const parsedURL = (() => {try {return new URL(deployment?.url);} catch {return null;}})();
      const url = parsedURL?.protocol === 'https:' && !parsedURL.username && !parsedURL.password ? parsedURL.href : null;
      return {projectId,verification:'provider_read',retrievedAt,
        deployment:deployment ? {id:deployment.id,state:deployment.state,environment:deployment.environment,createdAt:deployment.createdAt,
          commit:deployment.git?.commitSha||null,branch:deployment.git?.branch||null,url} : null,
        sources:[{id:`vercel:${assetId}:${deployment?.id||'project'}`,label:`Vercel deployment metadata · ${asset.name}`,url,retrievedAt,status:'provider_read'}],
        limitations:['This GET checks deployment metadata. Website availability and business outcomes require separate evidence.']};
    }
  });
}
