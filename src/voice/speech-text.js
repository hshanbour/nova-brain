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
