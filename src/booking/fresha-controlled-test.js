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
  for(const stale of context.pages().slice(1))await stale.close().catch(()=>{});const p=await context.newPage();draftPage=p;await p.goto(base,{waitUntil:'domcontentloaded'});assertTestOrigin(p.url());
  const card=p.locator('[id="calendar-event-booking-'+j.appointmentId+'"]');await card.waitFor({state:'attached',timeout:20000});
  const cardText=await card.innerText();if(!cardText.includes('Walk-in')||!cardText.includes(SERVICE.trim()))throw Error('test_card_details_mismatch');
  await card.click();await p.getByRole('dialog').last().waitFor();await p.getByRole('dialog').last().getByText(/Or leave empty for walk-ins/).first().waitFor({timeout:15000});await p.getByRole('dialog').last().getByText(/Hamood/).first().waitFor({timeout:15000});await diagnostic(p);
  const text=await p.getByRole('dialog').last().innerText();
  if(!text.includes('Or leave empty for walk-ins')||!text.includes('Hamood')||!text.includes(SERVICE.trim()))throw Error('test_readback_details_mismatch');
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
 const labelFor=iso=>(Number(iso.slice(11,13))%12||12)+':'+iso.slice(14,16)+' '+(Number(iso.slice(11,13))>=12?'pm':'am');
 async function freshTimes(){
  const q=await context.newPage();try{await q.goto(base,{waitUntil:'domcontentloaded'});await q.getByRole('button',{name:'Add',exact:true}).click();await q.getByRole('button',{name:'Appointment',exact:true}).click();await q.getByText('View available times',{exact:true}).click();await q.getByRole('button',{name:SERVICE,exact:true}).click();await q.getByRole('button',{name:'Continue',exact:true}).click();await q.getByRole('button',{name:'Any team member',exact:true}).click();await q.getByRole('button',{name:'Hamood',exact:true}).click();await q.getByRole('button',{name:APPROVED_DATE,exact:true}).waitFor();const slots=q.getByRole('dialog',{name:'Select a time',exact:true}).getByText(/^\d{1,2}:\d{2}\s*(am|pm)$/i);await slots.first().waitFor();return(await slots.allTextContents()).map(x=>x.trim());}finally{await q.close();}
 }
 async function readBack(previous){
 const j=await load();if(j.appointmentId!==previous?.appointmentId)throw Error('test_id_binding_mismatch');if(j.cancelAttempted)return await confirmCancelled(j);phase='read_back';const {p}=await inspectTest(j);
 const expected=j.targetStart||j.start;await p.getByRole('dialog').last().getByText(labelFor(expected)+' • 25m • Hamood',{exact:true}).waitFor({timeout:12000});
 const moved=!!j.rescheduleAttempted&&expected===j.targetStart;const result={state:moved?'rescheduled':'read_back',appointmentId:j.appointmentId,start:expected,end:moved?j.targetEnd:j.end,walkIn:true,observedAt:new Date().toISOString(),detail:moved?'Same test ID rescheduled; fresh provider read confirms the new time.':'Fresh provider read of the exact recorded test ID.'};
 await save({...await load(),...result,history:[...j.history,result]});
 return result;
 }
 async function reschedule(previous){
  const j=await load();if(j.appointmentId!==previous?.appointmentId||!j.createAttempted)throw Error('test_id_binding_mismatch');if(j.rescheduleAttempted)throw Error('reschedule_requires_reconciliation');
  phase='reschedule_availability';const labels=await freshTimes();const target=labels.find(x=>Date.parse(slotIso(x))>Math.max(Date.now()+5*60000,Date.parse(j.end)));if(!target)throw Error('no_future_reschedule_slot');const start=slotIso(target),end=new Date(Date.parse(start)+25*60000).toISOString().replace('.000','');
  phase='reschedule_binding';const {p}=await inspectTest(j);const u=new URL(p.url());if(u.searchParams.get('focusedBookingId')!==j.appointmentId||!u.pathname.includes('/view-appointment/'))throw Error('test_url_binding_mismatch');
  await p.getByRole('dialog').last().getByRole('button',{name:labelFor(j.start),exact:true}).click();
  const option=p.getByText(target,{exact:true});if(await option.count()!==1)throw Error('time_option_ambiguous');
  phase='reschedule_attempt';await save({...await load(),rescheduleAttempted:true,targetStart:start,targetEnd:end});await option.click({timeout:10000});
  const d=p.getByRole('dialog').last();await d.getByText(target+' • 25m • Hamood',{exact:true}).waitFor({timeout:10000});const text=await d.innerText();if(/conflict|overlap|not available|double.book/i.test(text))throw Error('reschedule_conflict');if(!text.includes('Or leave empty for walk-ins'))throw Error('client_scope_changed');if(await d.getByRole('checkbox').count())throw Error('notification_controls_require_inspection');
  await diagnostic(p);const saveButton=d.getByRole('button',{name:'Save',exact:true});await saveButton.waitFor({timeout:10000});await saveButton.click();
  await saveButton.waitFor({state:'hidden',timeout:15000});phase='reschedule_readback';const updated={...await load(),start,end};const back=await inspectTest(updated);await back.p.getByRole('dialog').last().getByText(target+' • 25m • Hamood',{exact:true}).waitFor({timeout:12000});
  const result={state:'rescheduled',appointmentId:j.appointmentId,start,end,walkIn:true,observedAt:new Date().toISOString(),detail:'Same test ID moved; fresh provider read confirms new time.'};await save({...await load(),...result,history:[...j.history,result]});return result;
 }

 async function confirmCancelled(j){
  phase='cancel_readback';const u=new URL(j.detailUrl);assertTestOrigin(u.href);if(u.searchParams.get('focusedBookingId')!==j.appointmentId||!u.pathname.includes('/view-appointment/'))throw Error('test_url_binding_mismatch');
  const p=await context.newPage();draftPage=p;await p.goto(u.href,{waitUntil:'domcontentloaded'});assertTestOrigin(p.url());const d=p.getByRole('dialog').last();await d.getByText(/Hamood/).first().waitFor({timeout:20000});await d.getByText('Cancelled',{exact:true}).first().waitFor({timeout:20000});await diagnostic(p);
  await d.getByText('Walk in',{exact:true}).waitFor({timeout:10000});await d.getByText(labelFor(j.start)+' • 25m • Hamood',{exact:true}).waitFor({timeout:10000});
  const result={state:'cancelled',appointmentId:j.appointmentId,start:j.start,end:j.end,walkIn:true,observedAt:new Date().toISOString(),detail:'Exact test ID cancelled with no fee; fresh provider detail confirms Cancelled.'};await save({...await load(),...result,history:[...j.history,result]});return result;
 }
 async function cancel(previous){
  const j=await load();if(j.appointmentId!==previous?.appointmentId||j.state!=='rescheduled'||!j.rescheduleAttempted)throw Error('test_cancel_binding_mismatch');if(j.cancelAttempted)return await confirmCancelled(j);
  phase='cancel_binding';const {p}=await inspectTest(j);const u=new URL(p.url());if(u.searchParams.get('focusedBookingId')!==j.appointmentId||!u.pathname.includes('/view-appointment/'))throw Error('test_url_binding_mismatch');await p.getByRole('dialog').last().getByText(labelFor(j.start)+' • 25m • Hamood',{exact:true}).waitFor();
  await p.getByRole('button',{name:'Options',exact:true}).click();await p.getByRole('menuitem',{name:'Cancel',exact:true}).click();const d=p.getByRole('dialog',{name:'Are you sure you want to cancel?',exact:true});const submit=d.getByRole('button',{name:'Cancel appointment',exact:true});await submit.waitFor({timeout:20000});await d.getByText('No fee will be charged',{exact:true}).waitFor();
  if(await d.getByRole('checkbox').count()||/notify|notification|send.*email|charge.*fee.*£[1-9]/i.test(await d.innerText()))throw Error('cancel_notification_or_fee_requires_inspection');
  phase='cancel_attempt';await save({...await load(),cancelAttempted:true,cancelSubmittedAt:new Date().toISOString()});await submit.click();await submit.waitFor({state:'hidden',timeout:20000});return await confirmCancelled(await load());
 }

 return{async run(operation,previous){
   let stage=operation;try{
    if(new Date().toISOString().slice(0,10)!==APPROVED_DATE)throw Error('approval_date_expired');
    if(operation==='test_prepare')return await prepare();
    if(operation==='test_create')return await create();
    if(operation==='test_read')return await readBack(previous);
    if(operation==='test_reschedule')return await reschedule(previous);
    if(operation==='test_cancel')return await cancel(previous);
    throw Error('write_adapter_not_enabled');
   }catch(error){await writeFile(join(root,'test-error.txt'),String(error.message).slice(0,2200),{mode:0o600}).catch(()=>{});if(draftPage)await diagnostic(draftPage).catch(()=>{});const j=await load();return{state:j.createAttempted&&!j.appointmentId?'uncertain':'blocked',stage:phase||stage,appointmentId:j.appointmentId||previous?.appointmentId||null,observedAt:new Date().toISOString(),detail:/^[a-z_]+$/.test(error.message)?error.message:'provider_ui_changed_or_timeout'};}
 }};
}
