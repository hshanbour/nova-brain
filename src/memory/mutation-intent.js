// Memory tools cannot infer consent from retrieved records or the model's plan.
// Ambiguous requests remain read-only; Nova can ask the owner to clarify.
export function allowsMemoryMutation(tool, message) {
  if (!['memory_remember','memory_correct','memory_forget'].includes(tool)) return true;
  // A trailing restriction to the named record is not a cancellation of an
  // explicit deletion. Strip only this exact scope-limiting phrase; other
  // negations still fail closed.
  const text = String(message || '').trim().replace(/(?:[.!؛،]\s*|\s+)(?:do not|don't|don’t)\s+(?:delete|remove|forget)\s+(?:anything\s+else|any\s+other\s+(?:memories|records|information))[.!]*\s*$/iu,'').replace(/(?:[.!؛،]\s*|\s+)لا\s+(?:تحذف|تحذفي|تمسح|تمسحي)\s+(?:أي|اي)\s+(?:معلومات|ذاكرة|ذكريات|سجلات)\s+(?:ثانية|تانية|أخرى|اخرى)[.!]*\s*$/iu,'');
  if (/(?:do not|don't|don’t|never)\s+(?:\w+\s+){0,2}(?:save|store|remember|forget|delete|update)|(?:لا|بدون)\s+(?:تحفظ|تحفظي|تخزن|تخزني|تمسح|تمسحي|تحذف|تحذفي|تعيدي حفظ)/iu.test(text)) return false;
  if (tool === 'memory_forget') return /^(?:please\s+)?(?:forget|delete|remove)\b|^(?:من فضلك\s+)?(?:احذف|احذفي|احذفه|امسح|امسحي|انسي|انسى|انسَ)/iu.test(text);
  return /^(?:please\s+)?(?:remember\s+(?:that|this|my|the)|save\s+(?:this|that|my|the)|store\s+(?:this|that|my|the)|correct\s+(?:this|that|my|the)|update\s+(?:this|that|my|the))\b|^(?:من فضلك\s+)?(?:تذكر|تذكري|احفظ|احفظي|خزن|خزني|صحح|صححي|عدّل|عدّلي|عدل|عدلي|حدّث|حدّثي|حدث|حدثي)/iu.test(text);
}

export const requiresMemoryOnly = message => /\b(?:saved|active|durable)\s+memory\s+only\b|(?:الذاكرة\s+(?:النشطة|الدائمة)|الذاكرة)\s+فقط/iu.test(String(message||''))
  && !allowsMemoryMutation('memory_remember',message) && !allowsMemoryMutation('memory_forget',message);
