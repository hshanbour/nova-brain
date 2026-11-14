// Batch ~40ms at the hardware rate; no file, network or persistent storage.
class NovaTurnPcm extends AudioWorkletProcessor {
  constructor(){super();this.buf=new Float32Array(Math.ceil(sampleRate*.04));this.used=0;}
  process(inputs){
    const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){
      let sum=0;for(const channel of channels)sum+=channel[i];
      this.buf[this.used++]=sum/channels.length;
      if(this.used===this.buf.length){this.port.postMessage(this.buf,[this.buf.buffer]);this.buf=new Float32Array(Math.ceil(sampleRate*.04));this.used=0;}
    }
    return true;
  }
}
registerProcessor('nova-turn-pcm',NovaTurnPcm);
