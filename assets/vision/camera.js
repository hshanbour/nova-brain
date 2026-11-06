import {interpret,currentScene} from './observation.js';
export function attachCamera(panel){
  const video=panel.querySelector('video'),button=panel.querySelector('button'),feedback=panel.querySelector('output');
  let epoch=0,worker,stream,timer,observation,busy=false;
  function stop(note='Camera off'){
    ++epoch;clearTimeout(timer);worker?.terminate();worker=null;
    stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;
    observation=null;busy=false;delete panel.dataset.person;panel.style.removeProperty("--attention-x");video.hidden=true;button.textContent='Enable camera';button.setAttribute('aria-pressed','false');feedback.textContent=note;
  }
  async function start(){
    const id=++epoch;busy=true;feedback.textContent='Waiting for camera permission…';
    button.textContent='Turn camera off';button.setAttribute('aria-pressed','true');
    try{
      const s=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:12}},audio:false});
      if(id!==epoch){s.getTracks().forEach(t=>t.stop());return;}
      stream=s;s.getVideoTracks()[0].onended=()=>{if(id===epoch)stop('Camera disconnected.');};
      video.srcObject=s;video.hidden=false;await video.play();if(id!==epoch)return;
      feedback.textContent='Loading local recognition…';
      worker=new Worker('/assets/vision/perception-worker.js');
      const fail=()=>{if(id===epoch)stop('Local recognition is unavailable. Camera stopped.');};
      worker.onerror=fail;let previous=-1;
      const sample=async()=>{
        if(id!==epoch)return;
        if(video.readyState<2||previous===video.currentTime){timer=setTimeout(sample,200);return;}
        previous=video.currentTime;
        try{const frame=await createImageBitmap(video);if(id!==epoch){frame.close();return;}worker.postMessage({frame,time:performance.now()},[frame]);timer=setTimeout(fail,12000);}catch{fail();}
      };
      worker.onmessage=({data})=>{
        if(id!==epoch)return;clearTimeout(timer);
        if(data.type==='error')return fail();
        if(data.type==='observation'){
          observation=interpret(data);
          feedback.textContent=[...observation.objects.map(x=>x.label+' ('+x.position+')'),observation.gesture,observation.possiblePointingTarget&&'Possibly pointing at '+observation.possiblePointingTarget].filter(Boolean).join(' · ')||'No confident object or hand detection.';
          panel.style.setProperty('--attention-x',observation.personPosition===null?'50%':((1-observation.personPosition)*100)+'%');
          panel.dataset.person=String(observation.personPosition!==null);
        }
        timer=setTimeout(sample,data.type==='ready'?0:300);
      };
      timer=setTimeout(fail,60000);worker.postMessage({type:'init'});
    }catch(e){if(id===epoch)stop(e.name==='NotAllowedError'?'Camera permission was not granted.':'Camera unavailable. Check device access.');}
  }
  button.addEventListener('click',()=>busy?stop():void start());
  window.addEventListener('pagehide',()=>stop());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  window.addEventListener('hashchange',()=>stop());
  return {stop,position:()=>observation&&performance.now()-observation.time<2500?observation.personPosition:null,read:()=>currentScene(observation,performance.now())};
}
