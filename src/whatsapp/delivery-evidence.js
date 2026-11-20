import {createHash} from 'node:crypto';

const projectId='sharp-cuts-web';
export const receiptHash=value=>createHash('sha256').update(String(value)).digest('hex');
const statuses=['queued','sent','delivered','read','failed','undelivered'];
const eventId=(ownerId,providerId,status)=>`wa-receipt-${receiptHash(`${ownerId}:${providerId}:${status}`)}`;

// Durable minimal evidence, not raw callbacks: no contact, body, token or wamid.
// Persist BEFORE applying. Retrying a callback after a storage failure is safe.
export async function retainDeliveryEvidence(storage,ownerId,providerId,patch,identifier){
  const id=eventId(ownerId,providerId,patch.status);
  try {
    await storage.appendActivity({id,ownerId,projectId,action:'sharp_cuts_whatsapp_provider_receipt',status:'completed',
      summary:`Authenticated provider status received: ${patch.status}.`,
      metadata:{providerMessageHash:receiptHash(providerId),providerStatus:patch.status,errorCode:patch.errorCode||null,identifier}});
  } catch(error){if(error?.code!=='23505')throw error;}
}

export async function deliveryEvidence(storage,ownerId,providerId){
  if(!providerId)return [];
  const records=await Promise.all(statuses.map(status=>storage.getActivity(eventId(ownerId,providerId,status),ownerId)));
  return records.filter(record=>record?.projectId===projectId&&record.action==='sharp_cuts_whatsapp_provider_receipt');
}

export async function reconcileDeliveryEvidence(storage,ownerId,row){
  if(!row?.providerMessageSid)return row;
  const records=await deliveryEvidence(storage,ownerId,row.providerMessageSid);
  // Existing monotonic storage rules keep out-of-order callbacks from regressing.
  for(const record of records.sort((a,b)=>a.sequence-b.sequence)){
    row=await storage.updateWhatsAppOutboundByProviderSid(row.providerMessageSid,ownerId,
      {status:record.metadata.providerStatus,errorCode:record.metadata.errorCode})||row;
  }
  return row;
}
