import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const LOCATION='139805',origin='https://partners.fresha.com';
export function createFreshaBrowserOperations({context,root,verifyBusiness}){
 return{async run(operation,request){let p;try{
 if(!await verifyBusiness())return{state:'blocked',reason:'fresha_reauthentication_required'};
 const date=operation==='availability'?request.date:new Date().toISOString().slice(0,10);
 if(!/^20\d{2}-\d{2}-\d{2}$/.test(date))throw Error('invalid_date');
 p=await context.newPage();await p.goto(origin+'/calendar?date='+date+'&view=day&location_id='+LOCATION+'&calendar_selected_resources=e-working',{waitUntil:'domcontentloaded'});
 const u=new URL(p.url());if(u.origin!==origin||u.searchParams.get('location_id')!==LOCATION)throw Error('wrong_calendar');
 await p.getByRole('button',{name:'Add',exact:true}).click();await p.getByRole('button',{name:'Appointment',exact:true}).click();await p.getByText('View available times',{exact:true}).click();
 const dialog=p.getByRole('dialog').last();await dialog.getByRole('button',{name:'Haircut (no beard trim )',exact:true}).waitFor();
 if(operation==='catalogue'){
 await writeFile(join(root,'service-selector.txt'),await dialog.ariaSnapshot(),{mode:0o600});
 const services=await dialog.getByRole('button').evaluateAll(es=>es.map(e=>({name:e.getAttribute('aria-label')||e.innerText,card:e.parentElement.innerText})).filter(x=>/£/.test(x.card)).map(x=>({name:x.name.trim(),durationMinutes:Number(x.card.match(/(\d+)\s*(?:min|m)\b/)?.[1])||null,priceGbp:Number(x.card.match(/£\s*(\d+(?:\.\d+)?)/)?.[1])||null})).filter(x=>x.name&&x.name.length<120));
 await dialog.getByRole('button',{name:'Haircut (no beard trim )',exact:true}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();await p.getByRole('button',{name:'Any team member',exact:true}).click();const hamood=p.getByRole('button',{name:'Hamood',exact:true});await hamood.waitFor();let team=hamood;for(let depth=0;depth<6;depth++){team=team.locator('..');if(await team.getByRole('button',{name:'Any team member',exact:true}).count()===1&&await team.getByRole('button',{name:'Hamood',exact:true}).count()===1&&await team.getByRole('button').count()<=12)break;}await writeFile(join(root,'team-selector.txt'),await team.ariaSnapshot(),{mode:0o600});const staff=await team.getByRole('button').allTextContents();return{state:'catalogue_read',services,staff:staff.map(x=>x.trim()).filter(x=>x&&!/close|continue|any team|back|select|clear/i.test(x))};
 }
 if(operation!=='availability')throw Error('unsupported_operation');
 await dialog.getByRole('button',{name:request.service,exact:true}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();await p.getByRole('button',{name:'Any team member',exact:true}).click();await p.getByRole('button',{name:request.barber,exact:true}).click();await p.getByRole('button',{name:date,exact:true}).waitFor({timeout:10000});
 const d=p.getByRole('dialog',{name:'Select a time',exact:true});await d.getByText('Available times',{exact:true}).waitFor();const times=d.getByText(/^\d{1,2}:\d{2}\s*(am|pm)$/i);await times.first().or(d.getByText(/no.*(?:availability|times)|fully booked/i)).first().waitFor({timeout:10000});return{state:'availability_read',...request,times:(await times.allTextContents()).map(x=>x.trim())};
 }catch(e){return{state:'blocked',reason:/^[a-z_]+$/.test(e.message)?e.message:'provider_ui_needs_inspection'};}finally{await p?.close().catch(()=>{});}}};
}
