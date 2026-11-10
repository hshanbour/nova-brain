export const previewSessionLabel = session => session.synthetic === true
  ? 'Isolated synthetic Preview · Live Voice and external actions disabled · '
  : 'Private Nova Preview · Existing workspace · Outbound actions disabled · ';
export async function requireSyntheticSession(){
  const r=await fetch('/api/preview/session',{cache:'no-store'});
  if(!r.ok){location.replace('/signin.html');return new Promise(()=>{});}
  const session=await r.json();
  const banner=document.createElement('aside');banner.textContent=previewSessionLabel(session);
  banner.style.cssText='position:relative;z-index:10000;padding:10px;background:#17372b;color:#f2dfaa;text-align:center';
  const a=document.createElement('a');a.href='/signin.html';a.textContent='Account / sign out';a.style.color='inherit';banner.append(a);document.body.prepend(banner);
}
