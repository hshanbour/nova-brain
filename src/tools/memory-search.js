import {RISK_LEVELS} from '../policy/action-policy.js';

// A bounded retry against active, authorised records, never the conversation archive.
export function registerMemorySearch(registry,{storage,ownerId}){
  registry.register({name:'memory_search',description:'Search active saved memories when initial context does not contain the requested fact. Supply the entity/attribute as short keywords in BOTH English and Arabic; preserve qualifiers and never put a guessed answer in the query. Returns source IDs. Does not search chat history, restore deleted memories or save anything.',riskLevel:RISK_LEVELS.READ_ONLY,category:'memory',capability:'read',available:true,configurationStatus:'ready',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},
    validate({query}){if(!query?.trim()||query.length>600)throw Error('A bounded memory query is required.');},
    async execute({query},context={}){
      const memories=await storage.retrieveMemories(ownerId,query,{limit:12,scopeQuery:String(context.ownerMessage||query),skipTranslation:true});
      return {memories:memories.map(({id,content,category,scope,projectId,provenance})=>({id,content,category,scope,projectId,provenance})),sources:memories.map(m=>({id:m.id,label:'Active saved memory',updatedAt:m.updatedAt})),limits:'Only active records in this account and the projects explicitly named in the current owner request. These are candidates; verify entity and qualifiers before answering.'};
    }
  });
}
