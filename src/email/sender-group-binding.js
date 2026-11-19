import {createHash} from 'node:crypto';

// Dedicated owner/project-scoped receipt; no customer data or credentials.
export function createSenderGroupBinding({storage,ownerId}) {
  const projectId='sharp-cuts-web';
  const id=kind=>'sender-group-'+kind+'-'+createHash('sha256').update(ownerId+':'+projectId).digest('hex').slice(0,32);
  const read=async()=>{
    const row=await storage.getActivity(id('binding'),ownerId);
    return row?.projectId===projectId&&row.action==='sharp_cuts_sender_group_bound'?row.metadata.groupId:null;
  };
  return {read,
    async claim(){await storage.appendActivity({id:id('claim'),ownerId,projectId,action:'sharp_cuts_sender_group_create_claimed',status:'started',summary:'One dedicated empty Sender group creation attempt; reconcile before retry.',metadata:{contactsChanged:0,sent:0}});},
    async save(groupId){
      if(typeof groupId!=='string'||!/^[A-Za-z0-9_-]{2,80}$/.test(groupId))throw Error('Invalid Sender group receipt.');
      const prior=await read();if(prior===groupId)return;if(prior)throw Error('Dedicated audience binding differs; explicit reconciliation required.');
      try{await storage.appendActivity({id:id('binding'),ownerId,projectId,action:'sharp_cuts_sender_group_bound',status:'completed',summary:'Dedicated Sender audience bound; no contacts uploaded or messages sent.',metadata:{groupId,contactsChanged:0,sent:0}});}
      catch(error){if(await read()!==groupId)throw error;}
    }
  };
}
