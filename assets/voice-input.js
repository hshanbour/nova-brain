export function createVoiceInput({ SpeechRecognition, onText, onState, onError }) {
  if (!SpeechRecognition) return Object.freeze({ supported:false,start(){onError?.("Voice input is not supported in this browser.");},stop(){} });
  const recognition=new SpeechRecognition(); recognition.continuous=false; recognition.interimResults=true; recognition.lang="en-GB"; let finalText="";
  recognition.onstart=()=>onState?.("listening");
  recognition.onresult=(event)=>{let interim="";for(let index=event.resultIndex;index<event.results.length;index+=1){const text=event.results[index][0].transcript;if(event.results[index].isFinal)finalText+=text;else interim+=text;}onText?.(`${finalText}${interim}`.trim());};
  recognition.onerror=(event)=>{onState?.("idle");onError?.(event.error==="not-allowed"?"Microphone permission was denied.":"Voice input could not continue.");};
  recognition.onend=()=>{finalText="";onState?.("idle");};
  return Object.freeze({supported:true,start(){finalText="";recognition.start();},stop(){recognition.stop();}});
}
