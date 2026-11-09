// Optional view adapter. The existing Nova session owns all voice I/O.
export function createCurrentGlassAvatar({readSignal}){
 const element=document.createElement('div');element.className='nova-current-glass';
 const host=document.createElement('div');host.className='nova-current-glass-stage';
 const status=document.createElement('small');status.className='nova-current-glass-status';status.textContent='Current Glass · loading';status.setAttribute('role','status');
 const controls=document.createElement('nav');controls.setAttribute('aria-label','Current Glass view');
 let view='turn',active=false,version=0,dispose=null;
 for(const [value,label] of [['front','Front'],['quarter','Three-quarter'],['turn','Gentle turn']]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-pressed',String(view===value));
  button.onclick=()=>{view=value;for(const b of controls.children)b.setAttribute('aria-pressed',String(b===button));};controls.append(button);
 }
 element.append(host,status,controls);
 return {element,setState(){},
  async start(){if(active)return;active=true;const current=++version;
   try{const {createCoreScene}=await import('./current-glass/coreScene.js');if(!active||current!==version)return;
    dispose=createCoreScene(host,readSignal,()=>view,()=>{status.textContent='Current Glass · Nova Voice';element.dataset.ready='true';},()=>{status.textContent='Avatar unavailable · voice can continue';element.dataset.ready='error';},t=>{element.dataset.fps=String(t.fps);element.dataset.energy=String(t.coreEnergy);element.dataset.waves=String(t.waveCount);},()=> 'throat',()=>true,()=> 'molten',()=>({hair:true,face:true}),()=>false,()=>false);
   }catch{status.textContent='Avatar unavailable · voice can continue';element.dataset.ready='error';}
  },
  stop(){active=false;++version;dispose?.();dispose=null;element.dataset.ready='false';}
 };
}
