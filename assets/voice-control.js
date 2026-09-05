export function createVoiceControl({now=()=>Date.now(),ttlMs=120000}={}){
  let checkpoint=null;
  return Object.freeze({
    current:()=>checkpoint,
    isPaused:()=>checkpoint?.status==="paused_waiting_for_user",
    isResumable:()=>["paused_waiting_for_user","resumable"].includes(checkpoint?.status),
    isFresh:()=>{const started=Number.isFinite(checkpoint?.interruptedAt)?checkpoint.interruptedAt:checkpoint?.createdAt;return Boolean(checkpoint&&Number.isFinite(started)&&now()-started<=ttlMs);},
    replace:(value)=>{checkpoint=value?Object.freeze({...value}):null;return checkpoint;},
    update:(patch)=>{if(!checkpoint)return null;checkpoint=Object.freeze({...checkpoint,...patch});return checkpoint;},
    preserveForRestart:(playback={})=>{if(!checkpoint)return null;checkpoint=Object.freeze({...checkpoint,...playback,status:"resumable",interruptedAt:Number.isFinite(checkpoint.interruptedAt)?checkpoint.interruptedAt:now(),resumableUntil:now()+ttlMs});return checkpoint;},
    clear:()=>{checkpoint=null;},
    snapshot:()=>checkpoint?Object.freeze({...checkpoint}):null
  });
}
