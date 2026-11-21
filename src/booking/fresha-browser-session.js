import {createControlledFreshaTest} from './fresha-controlled-test.js';
import {mkdir, realpath, writeFile, rename, open, readFile, rm} from 'node:fs/promises';
import {resolve, relative, isAbsolute, join} from 'node:path';

export const FRESHA_CALENDAR = 'https://partners.fresha.com/calendar';
const SHARP_CUTS_LOCATION = '139805';
export function isSharpCutsCalendar(url) {
  try { const u=new URL(url);return u.origin==='https://partners.fresha.com'&&u.pathname==='/calendar'&&u.searchParams.get('location_id')===SHARP_CUTS_LOCATION; }
  catch { return false; }
}
export function assertDedicatedProfile(root, repositoryRoot) {
  const path=resolve(root), repo=resolve(repositoryRoot), rel=relative(repo,path);
  if(!rel || (!rel.startsWith('..')&&!isAbsolute(rel)) || !/[\\/]NovaBrain[\\/]FreshaExecutor$/i.test(path))
    throw Object.assign(Error('A dedicated FreshaExecutor directory outside the repository is required.'),{code:'unsafe_profile_path'});
  return path;
}

// Only these booleans leave the browser. No cookie, raw DOM, URL query, client
// name, calendar entry, screenshot or authentication response is logged.
export function connectionEvidence({url,calendarVisible=false,businessVisible=false,challengeVisible=false}) {
  let parsed;try{parsed=new URL(url);}catch{return{state:'unavailable',writesEnabled:false};}
  if(challengeVisible)return{state:'owner_intervention_required',writesEnabled:false};
  if(parsed.origin!=='https://partners.fresha.com')return{state:'sign_in_required',writesEnabled:false};
  if(calendarVisible)return{state:businessVisible?'business_visible':'business_verification_required',calendarVisible:true,businessVisible,writesEnabled:false};
  return{state:'sign_in_required',calendarVisible:false,businessVisible:false,writesEnabled:false};
}

export async function startFreshaBrowserSession({root,repositoryRoot,chromium,channel='msedge',executablePath,headless=false,localOnly=true}) {
  const dir=assertDedicatedProfile(root,repositoryRoot);
  // Bootstrap must establish the OS ACL first; do not create a world-readable
  // profile and fix permissions after cookies have been written.
  const canonical=await realpath(dir);
  if(resolve(canonical).toLowerCase()!==dir.toLowerCase())throw Error('Profile root must not be a symlink.');
  const lockPath=join(dir,'executor.lock');
  let lock;
  try{lock=await open(lockPath,'wx',0o600);}catch(error){
    if(error.code!=='EEXIST')throw error;
    const pid=Number(await readFile(lockPath,'utf8'));
    try{process.kill(pid,0);throw Object.assign(Error('Dedicated browser is already running.'),{code:'executor_already_running'});}catch(probe){
      if(probe.code!=='ESRCH')throw probe;
    }
    await rm(lockPath);lock=await open(lockPath,'wx',0o600);
  }
  await lock.writeFile(String(process.pid));await lock.close();
  let context;
  const release=async()=>{if(Number(await readFile(lockPath,'utf8').catch(()=>0))===process.pid)await rm(lockPath,{force:true});};
  try {
    await mkdir(join(dir,'profile'),{recursive:true,mode:0o700});
    context=await chromium.launchPersistentContext(join(dir,'profile'),{
      ...(executablePath?{executablePath}:{channel}),headless,viewport:null,acceptDownloads:false,
      // Keep the browser sandbox enabled. No remote-debugging port, extensions,
      // credential export, traces or screen recordings.
      chromiumSandbox:true,args:['--disable-background-networking','--disable-sync'],
    });
    const page=context.pages()[0]||await context.newPage();
    await page.goto(FRESHA_CALENDAR,{waitUntil:'domcontentloaded',timeout:60000});
    await page.getByRole('textbox',{name:'Email',exact:true}).or(page.getByRole('button',{name:'Add',exact:true})).first().waitFor({state:'visible',timeout:45000});
    // Fresh profiles show a modal cookie choice that traps focus. Resolve only
    // that known non-authentication dialog, never MFA/CAPTCHA/account consent.
    let loginInputVerified=false;
    if(new URL(page.url()).pathname.startsWith('/users/login')){
      const privacy=page.getByRole('dialog').filter({hasText:'Your privacy'});
      await privacy.waitFor({state:'visible',timeout:4000}).catch(()=>{});
      if(await privacy.isVisible().catch(()=>false))await privacy.getByRole('button',{name:'Only necessary',exact:true}).click();
      const email=page.getByRole('textbox',{name:'Email',exact:true});
      if(await email.isVisible().catch(()=>false)&&await email.inputValue()===''){
        await email.click();await email.pressSequentially('nova-input-check@example.invalid');
        loginInputVerified=await email.inputValue()==='nova-input-check@example.invalid';
        await email.fill('');
      }
    }
    // Independently read the business label from Fresha's authenticated settings
    // page. Keep this evidence in memory, scoped to this browser lifetime. A
    // generic Add button or a remembered location URL is not account evidence.
    let verifiedBusiness=false;
    async function verifyBusiness(){
      const check=await context.newPage();
      try {
        await check.goto('https://partners.fresha.com/setup',{waitUntil:'domcontentloaded',timeout:45000});
        await check.getByText('Manage settings for SHARP CUTS.',{exact:true}).waitFor({state:'visible',timeout:15000});
        verifiedBusiness=new URL(check.url()).origin==='https://partners.fresha.com';
      } catch { verifiedBusiness=false; }
      finally { await check.close(); }
      return verifiedBusiness;
    }
    if(await page.getByRole('button',{name:'Add',exact:true}).isVisible().catch(()=>false))await verifyBusiness();
    async function inspect(){
      const active=context.pages().find(p=>p.url().startsWith('https://partners.fresha.com'))||page;
      const visible=async locator=>locator.isVisible().catch(()=>false);
      const calendarVisible=await visible(active.getByRole('button',{name:'Add',exact:true}));
      const businessVisible=verifiedBusiness&&isSharpCutsCalendar(active.url());
      const challengeVisible=await visible(active.getByText(/verify you are human|security verification|enter.*verification code/i).first());
      return {...connectionEvidence({url:active.url(),calendarVisible,businessVisible,challengeVisible}),observedAt:new Date().toISOString(),localOnly,workerConnected:false,loginInputVerified};
    }
    async function saveStatus(){const status=await inspect(),tmp=join(dir,'status.tmp');await writeFile(tmp,JSON.stringify(status),{mode:0o600});await rename(tmp,join(dir,'status.json'));return status;}
    async function inspectAvailableTimes(){
      if(!verifiedBusiness)throw Object.assign(Error('Business must be verified first.'),{code:'business_verification_required'});
      const probe=await context.newPage();
      let stage='calendar';
      try {
        await probe.goto(`${FRESHA_CALENDAR}?date=2026-11-21&view=day&location_id=${SHARP_CUTS_LOCATION}&calendar_selected_resources=e-working`,{waitUntil:'domcontentloaded',timeout:45000});
        await probe.getByRole('button',{name:'Add',exact:true}).click({timeout:15000});
        stage='appointment_menu';await probe.getByRole('button',{name:'Appointment',exact:true}).click({timeout:10000});
        stage='available_times';await probe.getByText('View available times',{exact:true}).click({timeout:10000});
        stage='service';await probe.getByRole('button',{name:'Haircut (no beard trim )',exact:true}).click({timeout:10000});
        stage='continue';await probe.getByRole('button',{name:'Continue',exact:true}).click({timeout:10000});
        stage='team';await probe.getByRole('button',{name:'Any team member',exact:true}).click({timeout:10000});
        await probe.getByRole('button',{name:'Hamood',exact:true}).click({timeout:10000});
        stage='date';await probe.getByRole('button',{name:'2026-11-21',exact:true}).waitFor({state:'visible',timeout:10000});
        stage='times';
        await probe.getByText('Available times',{exact:true}).waitFor({state:'visible',timeout:15000});
        const slots=probe.getByRole('dialog',{name:'Select a time',exact:true}).getByText(/^\d{1,2}:\d{2}\s*(am|pm)$/i);
        await slots.first().waitFor({state:'attached',timeout:15000});
        const times=(await slots.allTextContents()).map(t=>t.trim()).filter(t=>/^\d{1,2}:\d{2}\s*(am|pm)$/i.test(t));
        // Stop at provider availability. Never select a customer or press Save,
        // Checkout, Book, Confirm or a cancellation control in this read probe.
        return {state:'availability_read',stage,locationId:SHARP_CUTS_LOCATION,date:'2026-11-21',teamMember:'Hamood',service:'Haircut (no beard trim )',times,writesEnabled:false,observedAt:new Date().toISOString()};
      } catch {
        return {state:'availability_read_incomplete',stage,writesEnabled:false,observedAt:new Date().toISOString()};
      }
    }
    const controlledTest=createControlledFreshaTest({context,root:dir,verifyBusiness});
    return{context,page,inspect,saveStatus,verifyBusiness,inspectAvailableTimes,runControlledTest:controlledTest.run,async close(){await context.close();await release();}};
  }catch(error){await context?.close().catch(()=>{});await release();throw error;}
}
