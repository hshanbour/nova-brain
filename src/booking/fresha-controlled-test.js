import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
export const APPROVED_DATE='2026-11-21',LOCATION='139805',SERVICE='Haircut (no beard trim )';
const base=`https://partners.fresha.com/calendar?date=${APPROVED_DATE}&view=day&location_id=${LOCATION}&calendar_selected_resources=e-working`;
export function slotIso(label){const m=/^(\d{1,2}):(\d{2})\s(am|pm)$/.exec(label);if(!m)return null;const h=Number(m[1])%12+(m[3]==='pm'?12:0);return `${APPROVED_DATE}T${String(h).padStart(2,'0')}:${m[2]}:00Z`;}
export function assertTestOrigin(url){const u=new URL(url);if(u.origin!=='https://partners.fresha.com'||!u.pathname.startsWith('/calendar')||u.searchParams.get('location_id')!==LOCATION)throw Error('wrong_calendar_origin');}
export function createControlledFreshaTest({context,root,verifyBusiness}){
 const journalPath=join(root,'controlled-test-20261121.json');let draftPage;
 const load=async()=>JSON.parse(await readFile(journalPath,'utf8').catch(()=>'{"history":[]}'));
 async function save(v){await writeFile(journalPath+'.tmp',JSON.stringify(v),{mode:0o600});await rename(journalPath+'.tmp',journalPath);}
 async function diagnostic(page){const dialog=page.getByRole('dialog').last();await writeFile(join(root,'test-form-inspection.txt'),await dialog.ariaSnapshot(),{mode:0o600});}
 async function prepare(){
  const old=await load();if(old.createAttempted||old.appointmentId)throw Error('creation_already_attempted');
  if(!await verifyBusiness())throw Error('business_verification_required');
  draftPage=await context.newPage();const p=draftPage;
  await p.goto(base,{waitUntil:'domcontentloaded'});assertTestOrigin(p.url());
  const beforeIds=await p.locator('[id^="calendar-event-booking-"]').evaluateAll(els=>els.map(x=>x.id));
  await p.getByRole('button',{name:'Add',exact:true}).click();await p.getByRole('button',{name:'Appointment',exact:true}).click();
  await p.getByText('View available times',{exact:true}).click();await p.getByRole('button',{name:SERVICE,exact:true}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();
  await p.getByRole('button',{name:'Any team member',exact:true}).click();await p.getByRole('button',{name:'Hamood',exact:true}).click();await p.getByRole('button',{name:APPROVED_DATE,exact:true}).waitFor();
  const d=p.getByRole('dialog',{name:'Select a time',exact:true});const times=d.getByText(/^\d{1,2}:\d{2}\s*(am|pm)$/i);await times.first().waitFor();
  const labels=(await times.allTextContents()).map(x=>x.trim());const future=labels.filter(x=>Date.parse(slotIso(x))>Date.now()+5*60000);if(future.length<2)throw Error('no_future_test_slots');
  const start=slotIso(future[0]),end=new Date(Date.parse(start)+25*60000).toISOString().replace('.000','');
  await d.getByText(future[0],{exact:true}).click();await d.getByRole('button',{name:'Continue',exact:true}).click();
  await p.getByRole('button',{name:'Save',exact:true}).waitFor({timeout:15000});
  assertTestOrigin(p.url());await diagnostic(p);
  const result={state:'prepared',stage:'unsaved_form',start,end,walkIn:await p.getByText('Or leave empty for walk-ins',{exact:true}).isVisible(),observedAt:new Date().toISOString(),detail:'Unsaved provider form; no appointment created.'};
  await save({...old,...result,beforeIds,draftUrl:p.url(),history:[...old.history,result]});return result;
 }
 return{async run(operation,previous){
   let stage=operation;try{
    if(new Date().toISOString().slice(0,10)!==APPROVED_DATE)throw Error('approval_date_expired');
    if(operation==='test_prepare')return await prepare();
    throw Error('write_adapter_not_enabled');
   }catch(error){const j=await load();return{state:j.createAttempted&&!j.appointmentId?'uncertain':'blocked',stage,appointmentId:j.appointmentId||previous?.appointmentId||null,observedAt:new Date().toISOString(),detail:/^[a-z_]+$/.test(error.message)?error.message:'provider_ui_changed_or_timeout'};}
 }};
}
