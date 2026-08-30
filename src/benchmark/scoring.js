const ARABIC_DIACRITICS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g;

export function normalizeTranscript(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(ARABIC_DIACRITICS, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function scoreTranscript(expected, actual) {
  const expectedTokens = tokens(expected); const actualTokens = tokens(actual);
  const distance = levenshtein(expectedTokens, actualTokens);
  const wer = expectedTokens.length ? distance / expectedTokens.length : actualTokens.length ? 1 : 0;
  const expectedNames = importantTokens(expectedTokens); const actualSet = new Set(actualTokens);
  const numbers = String(expected).match(/\d+/g) || []; const actualNumbers = String(actual).match(/\d+/g) || [];
  const scripts = scriptPresence(expected); const actualScripts = scriptPresence(actual);
  return Object.freeze({
    similarity: round(Math.max(0, 1 - wer)),
    wordErrorRate: round(wer),
    properNameRecall: recall(expectedNames, actualSet),
    numberRecall: recall(numbers, new Set(actualNumbers)),
    scriptMatch: scripts.arabic === actualScripts.arabic && scripts.latin === actualScripts.latin,
    codeSwitchPreserved: scripts.arabic && scripts.latin ? actualScripts.arabic && actualScripts.latin : true
  });
}

function tokens(value) { const normalized = normalizeTranscript(value); return normalized ? normalized.split(/\s+/) : []; }
function importantTokens(items) { return items.filter((item) => /nova|brain|sharp|cuts|github|mohammad|luton|محمد|شنبور/.test(item)); }
function recall(expected, actual) { return expected.length ? round(expected.filter((item) => actual.has(item)).length / expected.length) : 1; }
function scriptPresence(value) { return { arabic: /\p{Script=Arabic}/u.test(value), latin: /\p{Script=Latin}/u.test(value) }; }
function round(value) { return Math.round(value * 1000) / 1000; }
function levenshtein(a, b) { const row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) { const held = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = held; } } return row[b.length]; }

export function validateRatings(input) {
  const fields = ["understandingAccuracy", "arabicQuality", "englishQuality", "codeSwitchingQuality", "naturalness", "humanLikeQuality", "arabicPronunciation", "englishPronunciation", "levantineFeel", "mixedLanguageQuality", "clarity", "preferredOverallVoice"];
  const ratings = {};
  for (const field of fields) { if (input?.[field] === undefined) continue; const value = Number(input[field]); if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`${field} must be an integer from 1 to 5.`); ratings[field] = value; }
  if (!Object.keys(ratings).length) throw new Error("At least one rating from 1 to 5 is required.");
  ratings.notes = String(input?.notes || "").trim().slice(0, 1000);
  return ratings;
}

export function blindLabels(providerIds, seed) {
  return [...providerIds].sort((a, b) => hash(`${seed}:${a}`) - hash(`${seed}:${b}`) || a.localeCompare(b)).map((providerId, index) => ({ providerId, label: `Voice ${String.fromCharCode(65 + index)}` }));
}
function hash(value) { let result = 2166136261; for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return result >>> 0; }
