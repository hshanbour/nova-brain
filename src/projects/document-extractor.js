import { extname, basename } from "node:path";
import { unzipSync } from "fflate";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const PROJECT_DOCUMENT_LIMITS = Object.freeze({
  maxFileBytes: 4 * 1024 * 1024,
  maxPdfPages: 40,
  maxExtractedCharacters: 100_000,
  maxDocxXmlBytes: 2 * 1024 * 1024,
});

const SUPPORTED = Object.freeze({
  ".pdf": new Set(["application/pdf"]),
  ".docx": new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
  ".txt": new Set(["text/plain"]),
  ".md": new Set(["text/markdown", "text/plain", "text/x-markdown"]),
  ".markdown": new Set(["text/markdown", "text/plain", "text/x-markdown"]),
});
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|private[_ -]?key)\s*[:=]\s*\S+)/i;

export class ProjectSourceError extends Error {
  constructor(code, message, statusCode = 400, safeDiagnostics = {}) {
    super(message);
    this.name = "ProjectSourceError";
    this.code = code;
    this.statusCode = statusCode;
    this.safeDiagnostics = safeDiagnostics;
  }
}

const normalize = (value) => String(value || "").replace(/\u0000/g, " ").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const safeName = (value) => basename(String(value || "document")).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 180) || "document";
const decodeXml = (value) => value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (match, hex, decimal, named) => {
  if (named) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[named.toLowerCase()] || match;
  const code = Number.parseInt(hex || decimal, hex ? 16 : 10);
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
});

function validateEnvelope({ filename, mimeType, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ProjectSourceError("project_document_empty", "The uploaded document is empty.");
  if (buffer.length > PROJECT_DOCUMENT_LIMITS.maxFileBytes) throw new ProjectSourceError("project_document_too_large", "The uploaded document exceeds the 4 MB limit.", 413);
  const name = safeName(filename), extension = extname(name).toLowerCase(), allowed = SUPPORTED[extension];
  if (!allowed || !allowed.has(String(mimeType || "").toLowerCase())) throw new ProjectSourceError("project_document_type_unsupported", "Only validated PDF, DOCX, TXT, and Markdown documents are supported.");
  if (extension === ".pdf" && !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new ProjectSourceError("project_document_signature_invalid", "The PDF signature is invalid.");
  if (extension === ".docx" && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new ProjectSourceError("project_document_signature_invalid", "The DOCX signature is invalid.");
  return { name, extension, mimeType: String(mimeType).toLowerCase() };
}

async function extractPdf(buffer) {
  let loading;
  try {
    loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useWorkerFetch: false });
    const document = await loading.promise;
    if (document.numPages > PROJECT_DOCUMENT_LIMITS.maxPdfPages) throw new ProjectSourceError("project_document_page_limit", `PDF documents are limited to ${PROJECT_DOCUMENT_LIMITS.maxPdfPages} pages.`);
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number), content = await page.getTextContent();
      pages.push(content.items.map((item) => typeof item.str === "string" ? item.str : "").join(" "));
      page.cleanup();
      if (pages.join("\n\n").length > PROJECT_DOCUMENT_LIMITS.maxExtractedCharacters) throw new ProjectSourceError("project_document_text_limit", "The extracted document text exceeds the 100,000 character limit.");
    }
    await document.cleanup();
    return { text: normalize(pages.join("\n\n")), pageCount: document.numPages };
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw new ProjectSourceError("project_document_corrupt", "The PDF could not be safely extracted.");
  } finally { await loading?.destroy?.().catch?.(() => {}); }
}

function extractDocx(buffer) {
  let activeContent = false, oversized = false;
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer), { filter(file) {
      const name = file.name.replaceAll("\\", "/").toLowerCase();
      if (name.endsWith("vbaproject.bin") || name.includes("/embeddings/") || name.includes("/activex/")) activeContent = true;
      if (name === "word/document.xml" && file.originalSize > PROJECT_DOCUMENT_LIMITS.maxDocxXmlBytes) oversized = true;
      return name === "word/document.xml" && !oversized;
    } });
  } catch { throw new ProjectSourceError("project_document_corrupt", "The DOCX archive could not be safely extracted."); }
  if (activeContent) throw new ProjectSourceError("project_document_active_content", "DOCX files containing macros, embedded objects, or ActiveX content are not accepted.");
  if (oversized) throw new ProjectSourceError("project_document_text_limit", "The DOCX document XML exceeds the bounded extraction limit.");
  const xml = files["word/document.xml"];
  if (!xml) throw new ProjectSourceError("project_document_corrupt", "The DOCX document body is missing.");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(xml);
  const text = normalize(decodeXml(decoded.replace(/<w:(?:tab|br)\b[^>]*\/?\s*>/gi, "\n").replace(/<\/w:p\s*>/gi, "\n").replace(/<[^>]+>/g, " ")));
  return { text, pageCount: null };
}

function extractText(buffer) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new ProjectSourceError("project_document_encoding_invalid", "Text and Markdown documents must use valid UTF-8."); }
  return { text: normalize(text), pageCount: null };
}

export async function extractProjectDocument(input) {
  const envelope = validateEnvelope(input);
  const extracted = envelope.extension === ".pdf" ? await extractPdf(input.buffer) : envelope.extension === ".docx" ? extractDocx(input.buffer) : extractText(input.buffer);
  if (!extracted.text || extracted.text.length < 20) throw new ProjectSourceError("project_document_no_text", "The document contains no usable bounded text.");
  if (extracted.text.length > PROJECT_DOCUMENT_LIMITS.maxExtractedCharacters) throw new ProjectSourceError("project_document_text_limit", "The extracted document text exceeds the 100,000 character limit.");
  if (SECRET.test(extracted.text)) throw new ProjectSourceError("project_document_sensitive", "The document appears to contain credential material and was not retained.");
  return Object.freeze({ ...envelope, ...extracted, extractedCharacters: extracted.text.length, rawRetained: false });
}
