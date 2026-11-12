// Memory tools cannot infer consent from retrieved records or the model's plan.
// Ambiguous requests remain read-only; Nova can ask the owner to clarify.
export function allowsMemoryMutation(tool, message) {
  if (!['memory_remember','memory_correct','memory_forget'].includes(tool)) return true;
  // A trailing restriction to the named record is not a cancellation of an
  // explicit deletion. Strip only this exact scope-limiting phrase; other
  // negations still fail closed.
  const text = String(message || '').trim().replace(/(?:[.!؛،]\s*|\s+)(?:do not|don't|don’t)\s+(?:delete|remove|forget)\s+(?:anything\s+else|any\s+other\s+(?:memories|records|information))[.!]*\s*$/iu,'').replace(/(?:[.!؛،]\s*|\s+)لا\s+(?:تحذف|تحذفي|تمسح|تمسحي)\s+(?:أي|اي)\s+(?:معلومات|ذاكرة|ذكريات|سجلات)\s+(?:ثانية|تانية|أخرى|اخرى)[.!]*\s*$/iu,'');
  if (/(?:do not|don't|don’t|never)\s+(?:\w+\s+){0,2}(?:save|store|remember|forget|delete|update)|(?:لا|بدون)\s+(?:تحفظ|تحفظي|تخزن|تخزني|تمسح|تمسحي|تحذف|تحذفي|تعيدي حفظ)/iu.test(text)) return false;
  // Only a direct request prefix, never a quotation or recollection of a request.
  const request = text.replace(/^(?:please\s+)?(?:i (?:want|need) you to|could you|can you)\s+/iu, '').replace(/^(?:من فضلك\s+)?(?:بدي(?:ا?ك|اك|كي)|أريدك(?: أن)?|اريدك(?: ان)?|ممكن)\s+(تحفظي?|تخزني?|تتذكري?|تصححي?|تعدلي?|تحذفي?|تمسحي?|تنسي)\s+/u, (_, verb) => ({تحفظ:'احفظ',تحفظي:'احفظي',تخزن:'خزن',تخزني:'خزني',تتذكر:'تذكر',تتذكري:'تذكري',تصحح:'صحح',تصححي:'صححي',تعدل:'عدل',تعدلي:'عدلي',تحذف:'احذف',تحذفي:'احذفي',تمسح:'امسح',تمسحي:'امسحي',تنسي:'انسي'}[verb]+' '));
  if (tool === 'memory_forget') return /^(?:please\s+)?(?:forget|delete|remove)\b|^(?:من فضلك\s+)?(?:احذف|احذفي|احذفه|امسح|امسحي|انسي|انسى|انسَ)/iu.test(request);
  return /^(?:please\s+)?(?:remember\s+(?:that|this|my|the)|save\s+(?:this|that|my|the)|store\s+(?:this|that|my|the)|correct\s+(?:this|that|my|the)|update\s+(?:this|that|my|the))\b|^(?:من فضلك\s+)?(?:تذكر|تذكري|احفظ|احفظي|خزن|خزني|صحح|صححي|عدّل|عدّلي|عدل|عدلي|حدّث|حدّثي|حدث|حدثي)/iu.test(request);
}

export const requestedMemoryTool = message => allowsMemoryMutation('memory_forget',message) ? 'memory_forget' : allowsMemoryMutation('memory_remember',message) ? 'memory_remember' : null;
export function hasMemoryWriteReceipt(executions, tool) {
  return executions.some(item => item.name===tool && item.status==='completed' && (tool==='memory_forget' ? item.result?.deleted===true : item.result?.memory?.id && item.result.memory.status==='active'));
}

export const requiresMemoryOnly = message => /\b(?:saved|active|durable)\s+memory\s+only\b|(?:الذاكرة\s+(?:النشطة|الدائمة)|الذاكرة)\s+فقط/iu.test(String(message||''))
  && !allowsMemoryMutation('memory_remember',message) && !allowsMemoryMutation('memory_forget',message);
