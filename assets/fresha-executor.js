const endpoint='/api/business-automation/sharp-cuts/fresha-connection';
const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
export async function renderFreshaExecutor(host){
  host.replaceChildren(node('h1','Sharp Cuts · Fresha execution'),node('p','Controlled connection proof. Booking writes, checkout and customer messages remain disabled.'));
  const controls=node('div',''),status=node('p','Loading saved execution receipts…'),receipts=node('div','');
  status.setAttribute('role','status');receipts.setAttribute('aria-live','polite');
  host.append(controls,status,receipts);
  async function request(body){const r=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'Fresha check failed');return data;}
  async function refresh(){try{const data=await request();receipts.replaceChildren();for(const check of data.checks){const section=node('section','');section.style.cssText='padding:18px;margin:12px 0;border:1px solid #786335;border-radius:12px;overflow-wrap:anywhere';section.append(node('h2',check.status),node('p','Nova queue reference: '+check.id));const r=check.result;if(r){section.append(node('p','Executor result: '+r.state),node('p','Observed: '+r.observedAt));if(r.times)section.append(node('p',`${r.teamMember} · ${r.service} · ${r.date} (GMT)`),node('p','Fresha time labels: '+r.times.join(', ')));section.append(node('p','No appointment created, changed or cancelled.'));}receipts.append(section);}status.textContent=data.checks.length?'Receipts loaded from Nova’s saved queue.':'No executor receipts yet.';}catch(e){status.textContent=e.message;}}
  for(const [label,operation]of [['Check dedicated connection','inspect_connection'],['Read live test availability','inspect_availability']]){const b=node('button',label);b.className='secondary-button';b.onclick=async()=>{b.disabled=true;try{const result=await request({operation});status.textContent='Queued '+result.id+' — waiting for dedicated executor.';await refresh();}catch(e){status.textContent=e.message;}finally{b.disabled=false;}};controls.append(b);}
  const reload=node('button','Refresh execution results');reload.className='secondary-button';reload.onclick=refresh;controls.append(reload);
  await refresh();
}
