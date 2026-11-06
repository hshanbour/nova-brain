// Spectral-envelope estimates, not a transcription or phoneme recogniser.
// These are broad acoustic mouth shapes, independent of the spoken language.
export const rest=Object.freeze({open:0,round:0,wide:0,seal:0});
export function articulation(db,sampleRate,fftSize,level){
 if(level<.028||!db.length)return rest;
 const peak=(lo,hi)=>{let m=-110;for(let i=Math.ceil(lo*fftSize/sampleRate);i<=Math.min(db.length-1,Math.floor(hi*fftSize/sampleRate));i++)m=Math.max(m,db[i]);return m;};
 const unit=x=>Math.min(1,Math.max(0,x)),low=peak(140,390),f1=peak(420,950),back=peak(750,1450),front=peak(1700,3200),noise=peak(3700,7500);
 const gate=unit((level-.025)*6), hiss=unit((noise-Math.max(back,front)+15)/22);
 const seal=unit((low-Math.max(back,front,f1)-12)/18);
 return {open:gate*(1-seal)*(.12+.88*unit((f1-low+26)/31))*(1-.65*hiss),
 round:gate*(1-seal)*unit((back-front+4)/24)*(1-hiss),
 wide:gate*(1-seal)*unit((front-back+13)/25),seal:gate*seal};
}
