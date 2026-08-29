export const MICROPHONE_LANGUAGES = Object.freeze([
  ["English (UK)", "en-GB"], ["English (US)", "en-US"], ["Arabic", "ar-SA"],
  ["French", "fr-FR"], ["Spanish", "es-ES"], ["German", "de-DE"],
  ["Italian", "it-IT"], ["Romanian", "ro-RO"], ["Turkish", "tr-TR"]
]);

export function createVoiceInput({ SpeechRecognition, onText, onState, onError, storage, languageKey = "nova.voice.inputLanguage", defaultLanguage = "en-GB" }) {
  let language = storage?.getItem(languageKey) || defaultLanguage;
  if (!SpeechRecognition) return Object.freeze({ supported:false,start(){onError?.("Voice input is not supported in this browser.");},stop(){},getLanguage(){return language;},setLanguage(value){language=String(value||defaultLanguage);storage?.setItem(languageKey,language);} });
  const recognition=new SpeechRecognition(); recognition.continuous=false; recognition.interimResults=true; let finalText="";
  recognition.onstart=()=>onState?.("listening");
  recognition.onresult=(event)=>{let interim="";for(let index=event.resultIndex;index<event.results.length;index+=1){const text=event.results[index][0].transcript;if(event.results[index].isFinal)finalText+=text;else interim+=text;}onText?.(`${finalText}${interim}`.trim());};
  recognition.onerror=(event)=>{onState?.("idle");onError?.(event.error==="not-allowed"?"Microphone permission was denied.":"Voice input could not continue.");};
  recognition.onend=()=>{finalText="";onState?.("idle");};
  return Object.freeze({supported:true,start(){finalText="";recognition.lang=language;recognition.start();},stop(){recognition.stop();},getLanguage(){return language;},setLanguage(value){language=String(value||defaultLanguage);storage?.setItem(languageKey,language);}});
}
