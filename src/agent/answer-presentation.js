export const ANSWER_PRESENTATION_GUIDANCE = `ANSWER PRESENTATION:
- Match the language of the owner's current request unless the owner explicitly asks for another language.
- Write for quick scanning: use short descriptive headings, short paragraphs, bullets, and numbered steps when sequence matters.
- Bold important prices, decisions, limitations, and warnings. Prefer practical, direct language.
- Avoid giant tables and dense text walls. Use a compact table only when it materially improves a comparison; otherwise use grouped bullets.
- In Arabic, use natural business-report Arabic with clear headings and short sections. Keep English brand names, technical terms, URLs, numbers, and prices unchanged and readable.
- Preserve useful trusted citations and links exactly; never invent a source or URL.`;

const TRANSFORM_ACTION = /\b(?:rewrite|translate|summari[sz]e|reorgan(?:i[sz]e|ation)|reformat|simplify|restyle|shorten|condense)\b|(?:أعد\s+كتابة|اعادة\s+كتابة|إعادة\s+كتابة|ترجم|لخ[ّ]?ص|اختصر|أعد\s+تنظيم|نظ[ّ]?م|بس[ّ]?ط|غي[ّ]?ر\s+(?:التنسيق|الصياغة|الترتيب))/iu;
const EXISTING_CONTENT_REFERENCE = /\b(?:(?:the\s+)?(?:previous|prior|above|earlier|last|existing)\s+(?:report|answer|response|message|content|text)|(?:that|this)\s+(?:report|answer|response|message|content|text)|(?:report|answer|response|message|content|text)\s+(?:above|from\s+(?:this|the)\s+conversation))\b|(?:التقرير|الإجابة|الاجابة|الرد|النص|المحتوى)\s+(?:السابق|السابقة|أعلاه|اعلاه|المذكور|المذكورة|الموجود|الموجودة)|(?:في|من|بهذه|هذه)\s+(?:المحادثة|المحادثه)/iu;
const NEW_AUTHORITY_REQUEST = /\b(?:implement|code|debug|patch|commit|push|deploy|ship|merge|retry|resume|cancel|approve|requeue)\b|\b(?:coding|selfdev|orchestration|shipping)_[a-f0-9]{32}\b|(?:نف[ّ]?ذ|برمج|أصلح|انشر|ادفع|أعد\s+المحاولة|استأنف|ألغ|وافق)\b/iu;

export function isConversationLocalTransform(message) {
  const value = String(message || "").trim();
  return value.length > 0 && value.length <= 4_000 && TRANSFORM_ACTION.test(value) && EXISTING_CONTENT_REFERENCE.test(value) && !NEW_AUTHORITY_REQUEST.test(value);
}

function exactHttpsUrls(value) {
  const urls = new Set();
  for (const match of String(value || "").matchAll(/https:\/\/[^\s<>\])}]+/gi)) {
    try { urls.add(new URL(match[0].replace(/[.,;:!?]+$/, "")).href); } catch {}
  }
  return urls;
}

export function retainConversationLinks(message, conversationHistory) {
  const allowed = new Set();
  for (const item of conversationHistory || []) {
    if (item?.role !== "assistant") continue;
    for (const url of exactHttpsUrls(item.content)) allowed.add(url);
  }
  const linked = String(message || "").replace(/\[([^\]\r\n]{1,300})\]\((https:\/\/[^)\s]+)\)/gi, (match, label, rawUrl) => {
    try { return allowed.has(new URL(rawUrl).href) ? match : label; } catch { return label; }
  });
  return linked.replace(/https:\/\/[^\s<>\])}]+/gi, (rawUrl) => {
    const suffix = rawUrl.match(/[.,;:!?]+$/)?.[0] || "";
    const candidate = suffix ? rawUrl.slice(0, -suffix.length) : rawUrl;
    try { return allowed.has(new URL(candidate).href) ? rawUrl : `[unverified link omitted]${suffix}`; }
    catch { return "[invalid link omitted]"; }
  });
}
