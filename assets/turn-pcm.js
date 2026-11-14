// No completed turn is reused. Keep only a short onset buffer between VAD
// events; discard overlapping, empty and overlong turns rather than splice.
export function createTurnPcm(rate){
  let lead=[],leadFrames=0,blocks=[],frames=0,active=false,overflow=false;
  const clear=()=>{lead=[];blocks=[];frames=leadFrames=0;active=overflow=false;};
  return {clear,write(block){
    if(!(block instanceof Float32Array)||!block.length)return;
    if(active){if(overflow)return;frames+=block.length;if(frames>rate*28){overflow=true;blocks=[];return;}blocks.push(block);}
    else {lead.push(block);leadFrames+=block.length;while(lead.length&&leadFrames>rate*.32){leadFrames-=lead.shift().length;}}
  },begin(){if(active)clear();active=true;blocks=lead;frames=leadFrames;lead=[];leadFrames=0;},
  end(){if(!active||overflow||!frames){clear();return null;}
    const n=Math.floor(frames*16000/rate);if(n<1){clear();return null;}
    const pcm=new Uint8Array(44+n*2),v=new DataView(pcm.buffer),str=(i,s)=>{for(let j=0;j<s.length;j++)v.setUint8(i+j,s.charCodeAt(j));};
    str(0,'RIFF');v.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*2,true);
    let b=0,i=0,pos=0;for(let j=0;j<n;j++){const end=Math.max(pos+1,Math.round((j+1)*rate/16000));let sum=0,k=0;while(pos<end&&pos<frames){sum+=blocks[b][i++];k++;pos++;if(i===blocks[b].length){i=0;b++;}}v.setInt16(44+j*2,Math.round(Math.max(-1,Math.min(1,sum/(k||1)))*32767),true);}
    clear();return {bytes:pcm,durationSeconds:n/16000};
  }};
}
export async function attachTurnPcm(context,source){
  if(!context?.audioWorklet||typeof AudioWorkletNode!=='function'||context.sampleRate<16000)return null;
  await context.audioWorklet.addModule(new URL('./turn-pcm-worklet.js',import.meta.url));
  if(context.state==='closed')return null;
  const node=new AudioWorkletNode(context,'nova-turn-pcm',{numberOfOutputs:0}),capture=createTurnPcm(context.sampleRate);
  let lastFrame=-Infinity;
  source.connect(node);node.port.onmessage=e=>{capture.write(e.data);lastFrame=performance.now();};
  return {...capture,ready:()=>context.state==='running'&&performance.now()-lastFrame<300,dispose(){node.port.onmessage=null;node.port.close();try{source.disconnect(node);}catch{}node.disconnect();capture.clear();}};
}
