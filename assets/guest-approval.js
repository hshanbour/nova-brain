// Owner-controlled same-origin reauthentication. Credentials are never retained
// in storage, telemetry or console output. A grant permits public conversation only.
export function requestGuestApproval({unlockWorkspace=false}={}){return new Promise(resolve=>{
 const dialog=document.createElement('dialog');dialog.className='guest-approval';
 dialog.innerHTML='<form><h2>Owner approval</h2><p>Sign in again to allow a public guest conversation. The guest receives no private projects, history, memories or tools.</p><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p role="status"></p><button type="submit">Approve public guest</button><button type="button" data-cancel>Cancel</button></form>';
 document.body.append(dialog);const form=dialog.querySelector('form'),status=form.querySelector('[role=status]');
 if(unlockWorkspace){dialog.querySelector('h2').textContent='Unlock private workspace';dialog.querySelector('p').textContent='Verify your account to return to private chat. Voice verification remains required for private Voice Mode.';form.querySelector('[type=submit]').textContent='Unlock workspace';}
 const finish=value=>{form.reset();dialog.close();dialog.remove();resolve(value);};
 dialog.querySelector('[data-cancel]').onclick=()=>finish(null);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});
 form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
  try{const email=form.elements.email.value,password=form.elements.password.value;const response=await fetch(unlockWorkspace?'/api/auth/sign-in/email':'/api/auth/approve-guest',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});form.elements.password.value='';const data=await response.json();if(!response.ok||(!unlockWorkspace&&!data.guestApproval))throw Error('Owner sign-in could not be verified.');if(unlockWorkspace){const session=await fetch('/api/preview/session',{cache:'no-store'});if(!session.ok)throw Error('Workspace unavailable');}finish(unlockWorkspace?true:data.guestApproval);}catch{status.textContent='Owner sign-in could not be verified. Private conversation remains paused.';button.disabled=false;}
 });dialog.showModal();
});}
