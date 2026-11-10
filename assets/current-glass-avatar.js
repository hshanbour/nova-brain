import {createVisualDemo} from './current-glass/visualDemo.js';
import {GLASS_SCENES} from './current-glass/sceneEnvironment.js';
// Optional view adapter. The existing Nova session owns all voice I/O.
export function createCurrentGlassAvatar({readSignal,onDemo=()=>{}}){
 const element=document.createElement('div');element.className='nova-current-glass';
 const host=document.createElement('div');host.className='nova-current-glass-stage';
 const status=document.createElement('small');status.className='nova-current-glass-status';status.textContent='Loading Nova…';status.setAttribute('role','status');
 const controls=document.createElement('div');controls.className='glass-scene-settings';
 const label=document.createElement('label');label.textContent='Scene';
 const select=document.createElement('select');select.id='glassScene';select.setAttribute('aria-label','Nova scene');
 const requested=new URLSearchParams(location.search).get('scene');
 let scene=GLASS_SCENES.some(([id])=>id===requested)?requested:'emerald';
 for(const [id,name] of GLASS_SCENES){const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option);}
 select.value=scene;select.onchange=()=>{scene=select.value;element.dataset.scene=scene;traceButton.disabled=session||scene!=='emerald';};label.append(select);controls.append(label);element.dataset.scene=scene;
 const views=document.createElement('nav');views.setAttribute('aria-label','Nova viewing angle');
 let view='turn',active=false,version=0,dispose=null,session=false,entrance=0,trace=0;
 const demoButtons=[];const demoLabel=document.createElement('small');demoLabel.setAttribute('role','status');demoLabel.textContent='Visual demos · microphone off';
 const demo=createVisualDemo({onChange:({message,mode})=>{demoLabel.textContent=message;element.dataset.demo=mode;onDemo(message);}});
 const reactions=document.createElement('nav');reactions.setAttribute('aria-label','Visual reactions without microphone');
 for(const [value,text] of [['idle','Idle demo'],['listening','Listening demo'],['speaking','Speaking demo']]){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>{trace=0;demo.choose(value);};demoButtons.push(b);reactions.append(b);}
 const interrupt=document.createElement('button');interrupt.type='button';interrupt.textContent='Interrupt demo';interrupt.onclick=()=>{trace=0;demo.stop();};demoButtons.push(interrupt);reactions.append(interrupt);
 const replay=document.createElement('button');replay.type='button';replay.textContent='Replay Entrance';replay.onclick=()=>{entrance++;};const traceButton=document.createElement('button');traceButton.type='button';traceButton.textContent='Follow one pulse';traceButton.disabled=scene!=='emerald';traceButton.onclick=()=>{demo.choose('idle');trace++;demoLabel.textContent='Single pulse · visual timing demo, no audio';onDemo(demoLabel.textContent);};demoButtons.push(traceButton);controls.append(replay,reactions,traceButton,demoLabel);
 for(const [value,text] of [['front','Front'],['quarter','Three-quarter'],['turn','Gentle turn']]){
  const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute('aria-pressed',String(view===value));
  button.onclick=()=>{view=value;for(const b of views.children)b.setAttribute('aria-pressed',String(b===button));};views.append(button);
 }
 controls.append(views);element.append(host,status);
 return {element,controls,setState(){},setSession(value){if(value&&!session)entrance++;session=value;if(value)trace=0;demo.setLive(value);for(const b of demoButtons)b.disabled=value;traceButton.disabled=value||scene!=="emerald";},
  async start(){if(active)return;active=true;const current=++version;
   try{const {createCoreScene}=await import('./current-glass/coreScene.js');if(!active||current!==version)return;
    dispose=createCoreScene(host,()=>session?readSignal():demo.read(),()=>view,()=>{status.textContent='';element.dataset.ready='true';},()=>{status.textContent='Avatar unavailable · voice can continue';element.dataset.ready='error';},t=>{for(const [key,value] of Object.entries(t))element.dataset[key]=String(value);},()=> 'throat',()=>true,()=> 'molten',()=>({hair:true,face:true}),()=>false,()=>scene!=='baseline',()=>scene,()=>entrance,()=>trace);
   }catch{status.textContent='Avatar unavailable · voice can continue';element.dataset.ready='error';}
  },
  stop(){demo.dispose();session=false;active=false;++version;dispose?.();dispose=null;element.dataset.ready='false';}
 };
}
