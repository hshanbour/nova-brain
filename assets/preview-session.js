export const previewSessionLabel = session => session.synthetic === true
  ? 'Isolated synthetic Preview · Live Voice and external actions disabled · '
  : 'Private Nova Preview · Existing workspace · Outbound actions disabled · ';
export async function readPreviewSession(fetchImpl=globalThis.fetch){
  try{
    const r=await fetchImpl('/api/preview/session',{cache:'no-store',credentials:'same-origin'});
    if([401,403].includes(r.status))return {state:'signed-out'};
    if(!r.ok)return {state:'unavailable'};
    return {state:'verified',session:await r.json()};
  }catch{return {state:'unavailable'};}
}
export async function requireSyntheticSession(){
  let check=await readPreviewSession();
  while(check.state==='unavailable'){
    // Network/Neon downtime does not invalidate or delete the account session.
    // Hold application boot until revalidation succeeds; never show private data.
    const notice=document.createElement('aside');notice.setAttribute('role','alert');
    notice.textContent='Nova cannot check your session right now. Your login has not been cleared. ';
    notice.style.cssText='position:fixed;inset:0;z-index:20000;background:#10251d;color:#f4e7cd;padding:40px';
    const retry=document.createElement('button');retry.textContent='Retry connection';notice.append(retry);document.body.append(notice);
    await new Promise(resolve=>retry.addEventListener('click',resolve,{once:true}));notice.remove();check=await readPreviewSession();
  }
  if(check.state==='signed-out'){location.replace('/signin.html');return new Promise(()=>{});}
  const session=check.session;
  const banner=document.createElement('aside');banner.textContent=previewSessionLabel(session);
  banner.style.cssText='position:relative;z-index:10000;padding:10px;background:#17372b;color:#f2dfaa;text-align:center';
  const a=document.createElement('a');a.href='/signin.html';a.textContent='Account / sign out';a.style.color='inherit';banner.append(a);document.body.prepend(banner);
}
