const INTERNAL_LINE = /^(?:tool(?: call| result| trace)?|metadata|internal|system|developer|arguments?|function)\s*:/i;

export function sanitiseSpeechText(value, maxCharacters = 1800) {
  let text = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, " ")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/^\s*(?:[-+•]|\d+[.)])\s+/gm, "")
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_LINE.test(line.trim()))
    .join(" ")
    .replace(/(^|\s)[#>*_~|]+(?=\s|$)/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/^[\[{][\s\S]*[\]}]$/.test(text)) return "";
  if (text.length > maxCharacters) {
    const bounded = text.slice(0, maxCharacters + 1);
    const boundary = Math.max(bounded.lastIndexOf(". "), bounded.lastIndexOf("؟ "), bounded.lastIndexOf("! "), bounded.lastIndexOf("? "));
    text = (boundary >= Math.floor(maxCharacters * 0.6) ? bounded.slice(0, boundary + 1) : bounded.slice(0, maxCharacters)).trim();
  }
  return text;
}

export function chunkSpeechText(text, { firstChunkCharacters = 180, nextChunkCharacters = 420, maxChunks = 8 } = {}) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const chunks = [];
  let remaining = source;
  while (remaining && chunks.length < maxChunks) {
    const limit = chunks.length === 0 ? firstChunkCharacters : nextChunkCharacters;
    if (remaining.length <= limit || chunks.length === maxChunks - 1) {
      chunks.push(remaining);
      break;
    }
    const window = remaining.slice(0, limit + 1);
    const minimum = Math.min(60, Math.floor(limit * 0.4));
    let splitAt = semanticBoundary(window, minimum, limit);
    if (splitAt < 0) splitAt = window.lastIndexOf(" ", limit);
    if (splitAt < minimum) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks.filter(Boolean);
}

function semanticBoundary(value, minimum, limit) {
  let boundary = -1;
  const pattern = /[.!?؟؛،,:]\s+/gu;
  for (const match of value.matchAll(pattern)) {
    const candidate = match.index + match[0].trimEnd().length;
    if (candidate >= minimum && candidate <= limit) boundary = candidate;
  }
  return boundary;
}
