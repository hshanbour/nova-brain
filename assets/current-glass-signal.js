// Visual-only contract: no credentials, transcripts, microphone or audio ownership.
export function createGlassSignal(){
 let state='idle',active=false,realtime=false,input=0,output=0;
 const clamp=v=>Number.isFinite(v)?Math.max(0,Math.min(1,v)):0;
 return {
  state(event){state=event.state;active=Boolean(event.active);realtime=event.mode==='realtime';if(state!=='speaking'||!active)output=0;if(!active||state==='muted')input=0;},
  input(v){input=clamp(v);},output(v){output=active&&realtime?clamp(v):0;},
  reset(){state='idle';active=realtime=false;input=output=0;},
  read(){const speaking=active&&realtime&&(state==='speaking'||output>.002);return {microphone:active&&state==='listening'?input:0,playback:speaking?output:0,listening:active&&state==='listening',speaking,phase:speaking?'speaking':state==='thinking'||state==='executing'?'preparing':state==='listening'?'listening':'idle'};}
 };
}
