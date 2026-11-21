import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
export const APPROVED_DATE='2026-11-21',LOCATION='139805',SERVICE='Haircut (no beard trim )';
const base=`https://partners.fresha.com/calendar?date=${APPROVED_DATE}&view=day&location_id=${LOCATION}&calendar_selected_resources=e-working`;
export function slotIso(label){const m=/^(\d{1,2}):(\d{2})\s(am|pm)$/.exec(label);if(!m)return null;const h=Number(m[1])%12+(m[3]==='pm'?12:0);return `${APPROVED_DATE}T${String(h).padStart(2,'0')}:${m[2]}:00Z`;}
export function assertTestOrigin(url){const u=new URL(url);if(u.origin!=='https://partners.fresha.com'||!u.pathname.startsWith('/calendar')||u.searchParams.get('location_id')!==LOCATION)throw Error('wrong_calendar_origin');}
export function createControlledFreshaTest({context,root,verifyBusiness}){
 const journalPath=join(root,'controlled-test-20261121.json');let draftPage,phase;
 const load=async()=>JSON.parse(await readFile(journalPath,'utf8').catch(()=>'{"history":[]}'));
 async function save(v){await writeFile(journalPath+'.tmp',JSON.stringify(v),{mode:0o600});await rename(journalPath+'.tmp',journalPath);}
 async function diagnostic(page){const dialog=page.getByRole('dialog').last();await writeFile(join(root,'test-form-inspection.txt'),await dialog.ariaSnapshot({timeout:2000}),{mode:0o600});}
 async function prepare(){
  const old=await load();if(old.createAttempted||old.appointmentId)throw Error('creation_already_attempted');
  if(!await verifyBusiness())throw Error('business_verification_required');
  phase='open_calendar';draftPage=await context.newPage();const p=draftPage;
  await p.goto(base,{waitUntil:'domcontentloaded'});assertTestOrigin(p.url());
  await p.getByRole('button',{name:'Add',exact:true}).waitFor();await p.locator('[id^="calendar-event-booking-"]').first().waitFor({state:'attached',timeout:15000});const beforeIds=await p.locator('[id^="calendar-event-booking-"]').evaluateAll(els=>els.map(x=>x.id));if(!beforeIds.length)throw Error('calendar_baseline_missing');
  phase='add';await p.getByRole('button',{name:'Add',exact:true}).click();await p.getByRole('button',{name:'Appointment',exact:true}).click();
  phase='availability';await p.getByText('View available times',{exact:true}).click();await p.getByRole('button',{name:SERVICE,exact:true}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();
  phase='barber';await p.getByRole('button',{name:'Any team member',exact:true}).click();await p.getByRole('button',{name:'Hamood',exact:true}).click();await p.getByRole('button',{name:APPROVED_DATE,exact:true}).waitFor();
  phase='time_labels';const d=p.getByRole('dialog',{name:'Select a time',exact:true});const times=d.getByText(/^\d{1,2}:\d{2}\s*(am|pm)$/i);await times.first().waitFor();
  const labels=(await times.allTextContents()).map(x=>x.trim());const future=labels.filter(x=>Date.parse(slotIso(x))>Date.now()+5*60000);if(future.length<2)throw Error('no_future_test_slots');
  const start=slotIso(future[0]),end=new Date(Date.parse(start)+25*60000).toISOString().replace('.000','');
  phase='select_time';const label=d.getByText(future[0],{exact:true});await writeFile(join(root,'time-control.html'),await label.evaluate(el=>el.parentElement.parentElement.outerHTML),{mode:0o600});let card=label,selected=false;for(let depth=0;depth<6;depth++){card=card.locator('..');if(await card.getByRole('button').count()===1&&await card.getByRole('heading').count()===1){await card.getByRole('button').click({timeout:8000});selected=true;break;}}if(!selected)throw Error('time_control_needs_inspection');phase='continue_time';await d.getByRole('button',{name:'Continue',exact:true}).click();
  phase='save_form';await p.getByRole('button',{name:'Save',exact:true}).waitFor({timeout:15000});
  assertTestOrigin(p.url());await diagnostic(p);await p.getByRole('button',{name:'Options',exact:true}).click();await writeFile(join(root,'test-options-inspection.txt'),await p.getByRole('menu').last().ariaSnapshot({timeout:3000}).catch(()=>p.getByRole('dialog').last().ariaSnapshot({timeout:3000})),{mode:0o600});await p.keyboard.press('Escape');
  const result={state:'prepared',stage:'unsaved_form',start,end,walkIn:await p.getByText('Or leave empty for walk-ins',{exact:true}).isVisible(),observedAt:new Date().toISOString(),detail:'Unsaved provider form; no appointment created.'};
  await save({...old,...result,beforeIds,draftUrl:p.url(),history:[...old.history,result]});return result;
 }

 async function inspectTest(j,{fresh=true}={}){
  if(!/^[0-9]{4,20}$/.test(j.appointmentId||''))throw Error('test_id_missing');
  if(j.beforeIds?.includes('calendar-event-booking-'+j.appointmentId))throw Error('preexisting_id_forbidden');
  const p=await context.newPage();draftPage=p;await p.goto(base,{waitUntil:'domcontentloaded'});assertTestOrigin(p.url());
  const card=p.locator('[id="calendar-event-booking-'+j.appointmentId+'"]');await card.waitFor({state:'attached',timeout:20000});
  const cardText=await card.innerText();if(!cardText.includes('Walk-in')||!cardText.includes(SERVICE.trim()))throw Error('test_card_details_mismatch');
  await card.click();await p.getByRole('dialog').last().waitFor();await p.getByRole('dialog').last().getByText(/Walk-in/).first().waitFor({timeout:15000});await p.getByRole('dialog').last().getByText(/Hamood/).first().waitFor({timeout:15000});await diagnostic(p);
  const text=await p.getByRole('dialog').last().innerText();
  if(!text.includes('Walk-in')||!text.includes('Hamood')||!text.includes(SERVICE.trim()))throw Error('test_readback_details_mismatch');
  await save({...j,detailUrl:p.url()});return {p,text};
 }
 async function create(){
  phase='create_guard';const prior=await load();if(prior.createAttempted||prior.appointmentId)throw Error('creation_already_attempted');
  await prepare();const j=await load(),p=draftPage;phase='validate_before_save';
  if(Date.parse(j.start)<=Date.now()+60000||!j.walkIn)throw Error('test_slot_expired_or_client_present');
  const dialog=p.getByRole('dialog').last(),text=await dialog.innerText();
  if(!text.includes('25m')||!text.includes('Hamood')||!text.includes(SERVICE.trim())||!text.includes('Or leave empty for walk-ins'))throw Error('test_form_mismatch');
  if(/conflict|not available|overlap|double.book/i.test(text))throw Error('test_slot_conflict');
  if(await dialog.getByRole('checkbox').count())throw Error('notification_controls_require_inspection');
  assertTestOrigin(p.url());phase='save_attempt';await save({...j,createAttempted:true,submittedAt:new Date().toISOString()});
  await dialog.getByRole('button',{name:'Save',exact:true}).click({timeout:10000});
  phase='identify_created';
  // Observe the provider UI; never retry Save. Existing IDs are excluded.
  await p.waitForURL(u=>!u.pathname.includes('new-appointment'),{timeout:20000}).catch(()=>{});
  const current=new URL(p.url());let id=current.pathname.match(/(?:booking|appointment)[^0-9]*([0-9]{4,20})(?:\/|$)/)?.[1];
  if(id&&j.beforeIds.includes('calendar-event-booking-'+id))throw Error('preexisting_id_forbidden');
  if(!id){
   const check=await context.newPage();await check.goto(base,{waitUntil:'domcontentloaded'});await check.locator('[id^="calendar-event-booking-"]').first().waitFor({state:'attached',timeout:15000});
   const cards=await check.locator('[id^="calendar-event-booking-"]').evaluateAll(es=>es.map(e=>({id:e.id,text:e.textContent})));
   const candidates=cards.filter(c=>!j.beforeIds.includes(c.id)&&c.text.includes('Walk-in')&&c.text.includes(SERVICE.trim())&&c.text.includes(String(Number(j.start.slice(11,13))%12||12)+':'+j.start.slice(14,16)));
   if(candidates.length!==1)throw Error('creation_requires_reconciliation');id=candidates[0].id.replace('calendar-event-booking-','');await check.close();
  }
  const recorded={...j,createAttempted:true,appointmentId:id,createdAt:new Date().toISOString()};await save(recorded);
  phase='created_readback';await inspectTest(recorded);
  const result={state:'created',appointmentId:id,start:j.start,end:j.end,walkIn:true,observedAt:new Date().toISOString(),detail:'Created once by dedicated worker; provider walk-in details read back.'};await save({...await load(),...result,history:[...j.history,result]});return result;
 }
 async function readBack(previous){const j=await load();if(j.appointmentId!==previous?.appointmentId)throw Error('test_id_binding_mismatch');phase='read_back';await inspectTest(j);return{state:'read_back',appointmentId:j.appointmentId,start:j.start,end:j.end,walkIn:true,observedAt:new Date().toISOString(),detail:'Fresh provider read of the exact recorded test ID.'};}

 return{async run(operation,previous){
   let stage=operation;try{
    if(new Date().toISOString().slice(0,10)!==APPROVED_DATE)throw Error('approval_date_expired');
    if(operation==='test_prepare')return await prepare();
    if(operation==='test_create')return await create();
    if(operation==='test_read')return await readBack(previous);
    throw Error('write_adapter_not_enabled');
   }catch(error){if(draftPage)await diagnostic(draftPage).catch(()=>{});const j=await load();return{state:j.createAttempted&&!j.appointmentId?'uncertain':'blocked',stage:phase||stage,appointmentId:j.appointmentId||previous?.appointmentId||null,observedAt:new Date().toISOString(),detail:/^[a-z_]+$/.test(error.message)?error.message:'provider_ui_changed_or_timeout'};}
 }};
}
