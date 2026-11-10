// One audio-triggered packet clock. A packet survives its full body-to-field journey.
export const TIDE_SLOTS=8;
export const TIDE_LIFETIME=5.2;
export const TIDE_PULSE_GLSL=`uniform float uTideBorn[8];uniform float uTideStrength[8];
float tidePacket(float age,float arrival,float strength){float d=age-arrival;
 float crest=exp(-pow(d/.095,2.));float trail=step(0.,d)*exp(-d/.25)*.40;
 return (crest+trail)*strength*step(0.,age)*(1.-smoothstep(4.8,5.2,age));}
float tideAt(float arrival){float value=0.;for(int i=0;i<8;i++)value+=tidePacket(uTime-uTideBorn[i],arrival,uTideStrength[i]);return min(value,1.5);}`;
export function createTideClock(){
 const born=new Float32Array(TIDE_SLOTS).fill(-100),strength=new Float32Array(TIDE_SLOTS);let last=-100,fast=0,slow=0,wasSpeaking=false,trace=0;
 const clear=()=>{born.fill(-100);strength.fill(0);fast=slow=0;last=-100;};
 function launch(time,amount){const slot=born.findIndex(b=>time-b>TIDE_LIFETIME);if(slot<0)return false;born[slot]=time;strength[slot]=Math.max(.35,Math.min(1,amount));last=time;return true;}
 return {born,strength,update(time,dt,speaking,level,traceRequest=0){
   if(!speaking&&wasSpeaking)clear();wasSpeaking=speaking;
   if(traceRequest!==trace){clear();trace=traceRequest;if(traceRequest)launch(time,1);}
   fast+=(level-fast)*(1-Math.exp(-dt*28));slow+=(level-slow)*(1-Math.exp(-dt*3));
   if(speaking&&fast>.10&&time-last>.72&&(fast-slow>.025||time-last>1.35))launch(time,fast*1.7);
   return this;
 },clear,active(time){return Array.from(born).filter(b=>time-b<TIDE_LIFETIME).length;},last(){return Math.max(...born);}};
}
