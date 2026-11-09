// Only explicit requests switch the active spoken language. Project names/noise do not.
export function explicitVoiceLanguage(text) {
  const value = String(text || "").trim();
  if (/(?:speak|reply|respond|continue|talk|switch)(?:\s+\w+){0,5}\s+(?:in\s+)?English\b/i.test(value) || /(?:احكي|احكيلي|تكلم|رد|جاوب|كملي|كمل|تابع|خليك).{0,35}(?:بالإنجليزي|بالانجليزي|إنجليزي|انجليزي)/u.test(value)) return "en";
  if (/(?:speak|reply|respond|continue|talk|switch)(?:\s+\w+){0,5}\s+(?:in\s+)?Arabic\b/i.test(value) || /(?:احكي|احكيلي|تكلم|رد|جاوب|كملي|كمل|تابع|خليك).{0,35}(?:عربي|العربية)/u.test(value) || /^(?:بالعربي|بالعربية)[.!؟]?$/u.test(value)) return "ar";
  return null;
}
