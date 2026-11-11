// Owner-controlled same-origin reauthentication. Credentials are never retained
// in storage, telemetry or console output. A grant permits public conversation only.
export function requestGuestApproval(){return new Promise(resolve=>{
 const dialog=document.createElement('dialog');dialog.className='guest-approval';
 dialog.innerHTML='<form><h2>Owner approval</h2><p>Sign in again to allow a public guest conversation. The guest receives no private projects, history, memories or tools.</p><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p role="status"></p><button type="submit">Approve public guest</button><button type="button" data-cancel>Cancel</button></form>';
 document.body.append(dialog);const form=dialog.querySelector('form'),status=form.querySelector('[role=status]');
 const finish=value=>{form.reset();dialog.close();dialog.remove();resolve(value);};
 dialog.querySelector('[data-cancel]').onclick=()=>finish(null);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});
 form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
  try{const email=form.elements.email.value,password=form.elements.password.value;const response=await fetch('/api/auth/approve-guest',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});form.elements.password.value='';const data=await response.json();if(!response.ok||!data.guestApproval)throw Error('Owner sign-in could not be verified. Check the credentials.');finish(data.guestApproval);}catch{status.textContent='Owner sign-in could not be verified. Private conversation remains paused.';button.disabled=false;}
 });dialog.showModal();
});}
