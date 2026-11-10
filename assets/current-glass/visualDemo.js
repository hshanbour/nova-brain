// Preview-only recorded audio. Never requests a microphone or creates a voice session.
export function createVisualDemo({onChange=()=>{},AudioClass=globalThis.Audio,ContextClass=globalThis.AudioContext||globalThis.webkitAudioContext,now=()=>performance.now()}={}){
 let mode='idle',live=false,generation=0,audio,ctx,analyser,data;
 const notify=message=>onChange({mode,live,message});
 function stop(next='idle'){generation++;audio?.pause();mode=next;notify(next==='listening'?'Listening demo · simulated microphone, no capture':'Idle demo · microphone off');}
 return {
  async choose(next){if(live)return;stop(next==='speaking'?'idle':next);if(next!=='speaking')return;
   const ticket=generation;
   try{if(!audio){audio=new AudioClass('/assets/current-glass/voice-demo.wav');audio.preload='none';audio.onended=()=>stop();audio.onerror=()=>{stop();notify('Recorded sample unavailable');};ctx=new ContextClass();analyser=ctx.createAnalyser();analyser.fftSize=256;data=new Float32Array(analyser.fftSize);ctx.createMediaElementSource(audio).connect(analyser);analyser.connect(ctx.destination);}
    await ctx.resume();if(ticket!==generation||live)return;audio.currentTime=4;await audio.play();if(ticket!==generation||live){audio.pause();return;}mode='speaking';notify('Speaking demo · recorded Nova audio, not a live reply');
   }catch{stop();notify('Audio could not start · try Speaking demo again');}
  },
  stop(){stop('listening');},
  setLive(value){if(value===live)return;live=value;stop();notify(value?'Live Nova session · demos disabled':'Idle demo · microphone off');},
  read(){let playback=0;if(mode==='speaking'&&!audio?.paused){analyser.getFloatTimeDomainData(data);let sum=0;for(const v of data)sum+=v*v;playback=Math.min(1,Math.sqrt(sum/data.length)*4);}
   return {phase:mode,speaking:mode==='speaking'&&!audio?.paused,listening:mode==='listening',playback,microphone:mode==='listening'?.06+.11*(.5+.5*Math.sin(now()*.005))**3:0};},
  dispose(){stop();audio?.removeAttribute?.('src');ctx?.close();audio=ctx=analyser=data=null;}
 };
}
