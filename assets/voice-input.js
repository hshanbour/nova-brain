export const MICROPHONE_LANGUAGES = Object.freeze([
  ["English (UK)", "en-GB"], ["English (US)", "en-US"], ["Arabic", "ar-SA"],
  ["French", "fr-FR"], ["Spanish", "es-ES"], ["German", "de-DE"],
  ["Italian", "it-IT"], ["Romanian", "ro-RO"], ["Turkish", "tr-TR"]
]);

export function createVoiceInput({ SpeechRecognition, onText, onFinal, onEnd, onState, onError, storage, languageKey = "nova.voice.inputLanguage", defaultLanguage = "en-GB" }) {
  let language = storage?.getItem(languageKey) || defaultLanguage;
  if (!SpeechRecognition) return Object.freeze({ supported:false,start(){onError?.("Voice input is not supported in this browser.");},stop(){},getLanguage(){return language;},setLanguage(value){language=String(value||defaultLanguage);storage?.setItem(languageKey,language);} });
  const recognition=new SpeechRecognition(); recognition.continuous=false; recognition.interimResults=true; let finalText="";let active=false;
  recognition.onstart=()=>{active=true;onState?.("listening");};
  recognition.onresult=(event)=>{let interim="";for(let index=event.resultIndex;index<event.results.length;index+=1){const text=event.results[index][0].transcript;if(event.results[index].isFinal)finalText+=`${finalText?" ":""}${text}`;else interim+=text;}onText?.(`${finalText}${interim}`.trim());};
  recognition.onerror=(event)=>{active=false;onState?.("idle");onError?.(event.error==="not-allowed"?"Microphone permission was denied.":`Voice input could not continue (${String(event.error||"unknown").slice(0,60)}).`);};
  recognition.onend=()=>{active=false;const completed=finalText.trim();finalText="";onState?.("idle");if(completed)onFinal?.(completed);onEnd?.({hadFinal:Boolean(completed)});};
  return Object.freeze({supported:true,start(){finalText="";recognition.lang=language;active=true;try{recognition.start();}catch(error){active=false;throw error;}},stop(){if(active)recognition.stop();},getLanguage(){return language;},setLanguage(value){language=String(value||defaultLanguage);storage?.setItem(languageKey,language);}});
}
