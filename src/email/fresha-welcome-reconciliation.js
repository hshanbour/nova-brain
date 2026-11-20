import {createHash} from 'node:crypto';
const email=value=>String(value||'').trim().toLowerCase();
const index=rows=>{const map=new Map();for(const row of rows){const key=email(row.Email);if(key)map.set(key,[...(map.get(key)||[]),row]);}return map;};

// Read-only preparation: no contact upload, source edit, or sending capability.
// Fresha's explicit email preference is never inferred as WhatsApp permission.
export function reconcileFreshaWelcome({original,current,upcomingIds,expectedUpcomingCount,providerSubscribers=[]}){
  const source=index(original),live=index(current),future=new Set(upcomingIds);
  if(future.size!==expectedUpcomingCount)throw Error('Upcoming appointment list is incomplete.');
  const ids=current.map(r=>r['Client ID']);
  if(ids.some(id=>!id)||new Set(ids).size!==ids.length||[...future].some(id=>!ids.includes(id)))throw Error('Current client identifiers cannot be reconciled.');
  const provider=index(providerSubscribers.map(r=>({...r,Email:r.email})));
  const counts={sourceAddresses:source.size,missingCurrent:0,marketingOptOut:0,blocked:0,sharedAddress:0,upcomingBooking:0,unknownPreference:0,providerSuppressed:0,eligible:0};
  const records=[];
  for(const [address,old] of source){
    const rows=live.get(address)||[];
    let reason=null;
    if(!rows.length)reason='missingCurrent';
    else if(rows.some(r=>r['Accepts Marketing']==='No'))reason='marketingOptOut';
    else if(rows.some(r=>r.Blocked==='Yes'))reason='blocked';
    else if(old.length!==1||rows.length!==1)reason='sharedAddress';
    else if(rows.some(r=>r['Accepts Marketing']!=='Yes'||r.Blocked!=='No'))reason='unknownPreference';
    else if(rows.some(r=>future.has(r['Client ID'])))reason='upcomingBooking';
    else if((provider.get(address)||[]).some(r=>r.status?.email!=='active'||r.unsubscribed_at||r.bounced_at))reason='providerSuppressed';
    counts[reason||'eligible']++;
    records.push({email:address,clientId:rows.length===1?rows[0]['Client ID']:null,eligible:!reason,reason});
  }
  const audienceHash=createHash('sha256').update(JSON.stringify(records.filter(r=>r.eligible).map(r=>r.email).sort())).digest('hex');
  return {counts,audienceHash,records,sourceRowsChanged:0,contactsUploaded:0,sent:0};
}
