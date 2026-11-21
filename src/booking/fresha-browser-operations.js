import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const LOCATION='139805',origin='https://partners.fresha.com';
export function readFreshaSelector(snapshot,{team=false}={}){
 const blocks=[];let current;
 for(const line of snapshot.split('\n')){const match=/^\s*- button ("(?:[^"\\]|\\.)*")/.exec(line);if(match){current={name:JSON.parse(match[1]),lines:[]};blocks.push(current);}else if(current)current.lines.push(line);}
 if(team)return blocks.map(x=>x.name).filter(x=>x!=='Any team member');
 return blocks.flatMap(x=>{const text=x.lines.join('\n'),duration=/\b(\d+)m\b/.exec(text),price=/(from )?£(\d+(?:\.\d+)?)/.exec(text);return duration&&price?[{name:x.name,durationMinutes:Number(duration[1]),priceGbp:Number(price[2]),priceFrom:!!price[1]}]:[];});
}
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
 const serviceSnapshot=await dialog.ariaSnapshot();await writeFile(join(root,'service-selector.txt'),serviceSnapshot,{mode:0o600});
 const services=readFreshaSelector(serviceSnapshot);
 await dialog.getByRole('button',{name:'Haircut (no beard trim )',exact:true}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();await p.getByRole('button',{name:'Any team member',exact:true}).click();const hamood=p.getByRole('button',{name:'Hamood',exact:true});await hamood.waitFor();let team=hamood;for(let depth=0;depth<6;depth++){team=team.locator('..');if(await team.getByRole('button',{name:'Any team member',exact:true}).count()===1&&await team.getByRole('button',{name:'Hamood',exact:true}).count()===1&&await team.getByRole('button').count()<=12)break;}await writeFile(join(root,'team-selector.txt'),await team.ariaSnapshot(),{mode:0o600});const staff=readFreshaSelector(await team.ariaSnapshot(),{team:true});return{state:'catalogue_read',services,staff};
 }
 if(operation!=='availability')throw Error('unsupported_operation');
 await dialog.getByRole('button',{name:request.service,exact:true}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();await p.getByRole('button',{name:'Any team member',exact:true}).click();await p.getByRole('button',{name:request.barber,exact:true}).click();await p.getByRole('button',{name:date,exact:true}).waitFor({timeout:10000});
 const d=p.getByRole('dialog',{name:'Select a time',exact:true});await d.getByText('Available times',{exact:true}).waitFor();const times=d.getByText(/^\d{1,2}:\d{2}\s*(am|pm)$/i);await times.first().or(d.getByText(/no.*(?:availability|times)|fully booked/i)).first().waitFor({timeout:10000});return{state:'availability_read',...request,times:(await times.allTextContents()).map(x=>x.trim())};
 }catch(e){return{state:'blocked',reason:/^[a-z_]+$/.test(e.message)?e.message:'provider_ui_needs_inspection'};}finally{await p?.close().catch(()=>{});}}};
}
