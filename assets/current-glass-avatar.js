import {GLASS_SCENES} from './current-glass/sceneEnvironment.js';
// Optional view adapter. The existing Nova session owns all voice I/O.
export function createCurrentGlassAvatar({readSignal}){
 const element=document.createElement('div');element.className='nova-current-glass';
 const host=document.createElement('div');host.className='nova-current-glass-stage';
 const status=document.createElement('small');status.className='nova-current-glass-status';status.textContent='Loading Nova…';status.setAttribute('role','status');
 const controls=document.createElement('div');controls.className='glass-scene-settings';
 const label=document.createElement('label');label.textContent='Scene';
 const select=document.createElement('select');select.id='glassScene';select.setAttribute('aria-label','Nova scene');
 const requested=new URLSearchParams(location.search).get('scene');
 let scene=GLASS_SCENES.some(([id])=>id===requested)?requested:'studio';
 for(const [id,name] of GLASS_SCENES){const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option);}
 select.value=scene;select.onchange=()=>{scene=select.value;element.dataset.scene=scene;};label.append(select);controls.append(label);element.dataset.scene=scene;
 const views=document.createElement('nav');views.setAttribute('aria-label','Nova viewing angle');
 let view='turn',active=false,version=0,dispose=null;
 for(const [value,text] of [['front','Front'],['quarter','Three-quarter'],['turn','Gentle turn']]){
  const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute('aria-pressed',String(view===value));
  button.onclick=()=>{view=value;for(const b of views.children)b.setAttribute('aria-pressed',String(b===button));};views.append(button);
 }
 controls.append(views);element.append(host,status);
 return {element,controls,setState(){},
  async start(){if(active)return;active=true;const current=++version;
   try{const {createCoreScene}=await import('./current-glass/coreScene.js');if(!active||current!==version)return;
    dispose=createCoreScene(host,readSignal,()=>view,()=>{status.textContent='';element.dataset.ready='true';},()=>{status.textContent='Avatar unavailable · voice can continue';element.dataset.ready='error';},t=>{for(const [key,value] of Object.entries(t))element.dataset[key]=String(value);},()=> 'throat',()=>true,()=> 'molten',()=>({hair:true,face:true}),()=>false,()=>scene!=='baseline',()=>scene);
   }catch{status.textContent='Avatar unavailable · voice can continue';element.dataset.ready='error';}
  },
  stop(){active=false;++version;dispose?.();dispose=null;element.dataset.ready='false';}
 };
}
