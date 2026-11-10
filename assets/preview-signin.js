const $=id=>document.getElementById(id);
async function session(){const r=await fetch('/api/preview/session',{cache:'no-store'});$('open').hidden=!r.ok;if(r.ok)$('status').textContent='Verified. Your authorised Preview workspace is ready.';return r.ok;}
async function act(path,body){
  document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const r=await fetch('/api/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Sign-in failed.');$('password').value='';$('code').value='';$('status').textContent=path==='sign-up/email'?'Check your email and enter the verification code below.':path==='email-otp/send-verification-otp'?'Check your email for a new code.':path==='sign-out'?'Signed out.':'Done. Checking your workspace…';if(path!=='sign-out')await session();else $('open').hidden=true;}
  catch(e){$('status').textContent=e.message;}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
$('login').onsubmit=e=>{e.preventDefault();act('sign-in/email',{email:$('email').value.trim(),password:$('password').value});};
$('signup').onclick=()=>{if($('login').reportValidity())act('sign-up/email',{email:$('email').value.trim(),password:$('password').value,name:'Preview Owner'});};
$('verify').onclick=()=>act('email-otp/verify-email',{email:$('email').value.trim(),otp:$('code').value.trim()});
$('resend').onclick=()=>act('email-otp/send-verification-otp',{email:$('email').value.trim(),type:'email-verification'});
$('signout').onclick=()=>act('sign-out',{});
session().catch(()=>{$('status').textContent='Sign-in service is unavailable. Please retry later.';});
