// Only explicit requests switch the active spoken language. Project names/noise do not.
// These are script counts, not guesses about language, identity or who spoke.
// Never persist the text of a public/uncertain turn for diagnostics.
export function voiceScriptCounts(text){
  let arabic=0,latin=0,other=0;
  for(const c of String(text||'').slice(0,12000)){if(!/\p{L}/u.test(c))continue;
    if(/\p{Script=Arabic}/u.test(c))arabic++;else if(/\p{Script=Latin}/u.test(c))latin++;else other++;}
  return {arabic,latin,other};
}
export function unsupportedVoiceScript({arabic,latin,other}){return other>=3&&other>2*(arabic+latin);}
export function explicitVoiceLanguage(text) {
  const value = String(text || "").trim();
  if (/(?:speak|reply|respond|continue|talk|switch)(?:\s+\w+){0,5}\s+(?:in\s+)?English\b/i.test(value) || /(?:احكي|احكيلي|تكلم|رد|جاوب|كملي|كمل|تابع|خليك).{0,35}(?:بالإنجليزي|بالانجليزي|إنجليزي|انجليزي)/u.test(value)) return "en";
  if (/(?:speak|reply|respond|continue|talk|switch)(?:\s+\w+){0,5}\s+(?:in\s+)?Arabic\b/i.test(value) || /(?:احكي|احكيلي|تكلم|رد|جاوب|كملي|كمل|تابع|خليك).{0,35}(?:عربي|العربية)/u.test(value) || /^(?:بالعربي|بالعربية)[.!؟]?$/u.test(value)) return "ar";
  return null;
}

// Deliberately narrow: a topic change, cancellation or business instruction
// appended to a language request must still supersede the previous work.
export function isVoiceLanguageOnlyChange(text){
  const value=String(text||'').toLowerCase().replace(/[،,.!?؟؛]/g,' ').replace(/\s+/g,' ').trim();
  if(!explicitVoiceLanguage(value))return false;
  if(/^(?:(?:please|can you|could you) )?(?:speak|reply|respond|continue|talk|switch)(?: to me| with me)?(?: in| to)? (?:arabic|english)(?: please)?$/.test(value))return true;
  return /^(?:(?:احكي|احكيلي|تكلمي|تكلم|ردي|رد|جاوبي|جاوب|كملي|كمل|تابعي|تابع)(?: معي| معاي| لي)?(?: باللغة الثانية)?\s*)?(?:احكي\s*)?(?:بالعربي|بالعربية|عربي|العربية|بالانجليزي|بالإنجليزي|انجليزي|إنجليزي)(?: لو سمحت[ي]?)?$/.test(value);
}
