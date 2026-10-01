import { createHash } from "node:crypto";

const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const HEADER_VALUE = /^[^\r\n]*$/;
const HEADER_CONTROL = /[\r\n\x00-\x1f\x7f]/;
const MESSAGE_ID = /^<[^<>\s]+>$/;

function text(value, name, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw invalid(`${name} must be a string.`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if ((!allowEmpty && !normalized) || normalized.length > max)
    throw invalid(`${name} is invalid or too long.`);
  return normalized;
}

function addresses(value, name, { required = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw invalid(`${name} must be a bounded email-address list.`);
  const normalized = [...new Set(value.map((item) => String(item).trim().toLowerCase()))];
  if ((required && normalized.length === 0) || normalized.some((item) => !EMAIL.test(item)))
    throw invalid(`${name} contains an invalid email address.`);
  return normalized;
}

function optionalHeader(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = text(value, name, 998);
  if (!HEADER_VALUE.test(normalized)) throw invalid(`${name} contains invalid header characters.`);
  return normalized;
}

function subject(value) {
  const normalized = text(value, "subject", 998, { allowEmpty: true });
  if (!HEADER_VALUE.test(normalized)) throw invalid("subject contains invalid header characters.");
  return normalized;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "gmail_input_invalid", statusCode: 400 });
}

export function normalizeSingleMailbox(value, name = "mailbox") {
  if (typeof value !== "string" || !value.trim() || value.length > 998 || HEADER_CONTROL.test(value))
    throw invalid(`${name} contains an invalid mailbox.`);
  const normalized = value.trim();
  if (EMAIL.test(normalized)) return normalized.toLowerCase();
  const match = normalized.match(/^([^<>]*)<([^<>]+)>$/);
  if (!match || !match[1].trim() || !EMAIL.test(match[2].trim()))
    throw invalid(`${name} contains an invalid or ambiguous mailbox.`);
  return match[2].trim().toLowerCase();
}

export function normalizeRfcMessageId(value, name = "messageId") {
  if (typeof value !== "string" || value.length > 998 || HEADER_CONTROL.test(value) || !MESSAGE_ID.test(value.trim()))
    throw invalid(`${name} contains an invalid RFC Message-ID.`);
  return value.trim();
}

export function deriveReplySubject(value) {
  const normalized = subject(value ?? "");
  const withoutPrefixes = normalized.replace(/^(?:\s*re\s*:\s*)+/i, "");
  return withoutPrefixes ? `Re: ${withoutPrefixes}` : "Re:";
}

export function deriveReplyReferences(value, sourceMessageId, { maxCount = 20, maxLength = 900 } = {}) {
  const source = normalizeRfcMessageId(sourceMessageId, "messageId");
  let tokens = [];
  if (value !== undefined && value !== null && value !== "") {
    if (typeof value !== "string" || value.length > 10_000 || HEADER_CONTROL.test(value))
      throw invalid("references contains invalid header characters.");
    const normalized = value.trim();
    if (!normalized || !/^<[^<>\s]+>(?:\s+<[^<>\s]+>)*$/.test(normalized))
      throw invalid("references contains invalid message identifiers.");
    tokens = normalized.split(/\s+/);
  }
  const seen = new Set();
  tokens = [...tokens, source].filter((token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  tokens = tokens.slice(-maxCount);
  while (tokens.length > 1 && tokens.join(" ").length > maxLength) tokens.shift();
  if (tokens.join(" ").length > maxLength) throw invalid("references is too long.");
  return tokens.join(" ");
}

export function normalizeDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid("Email draft input must be an object.");
  const draft = {
    to: addresses(input.to, "to", { required: true }),
    cc: addresses(input.cc, "cc"),
    bcc: addresses(input.bcc, "bcc"),
    subject: subject(input.subject),
    body: text(input.body, "body", 100_000),
    threadId: optionalHeader(input.threadId, "threadId"),
    inReplyTo: optionalHeader(input.inReplyTo, "inReplyTo"),
    references: optionalHeader(input.references, "references"),
  };
  return Object.freeze(draft);
}

export function draftIntentHash(draft) {
  return createHash("sha256").update(JSON.stringify({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    threadId: draft.threadId || null,
    inReplyTo: draft.inReplyTo || null,
    references: draft.references || null,
  })).digest("hex");
}

function encodeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawEmail(draft, { from, messageId }) {
  const headers = [
    `From: ${from}`,
    `To: ${draft.to.join(", ")}`,
    ...(draft.cc.length ? [`Cc: ${draft.cc.join(", ")}`] : []),
    ...(draft.bcc.length ? [`Bcc: ${draft.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    `Message-ID: <${messageId}>`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`] : []),
    ...(draft.references ? [`References: ${draft.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${draft.body.replace(/\n/g, "\r\n")}`, "utf8")
    .toString("base64url");
}

export function extractMessage(payload) {
  const headers = Object.fromEntries((payload?.headers || []).map(({ name, value }) => [String(name).toLowerCase(), value]));
  const collect = (part, mimeType) => {
    if (!part) return [];
    const own = part.mimeType === mimeType && part.body?.data
      ? [Buffer.from(part.body.data, "base64url").toString("utf8")]
      : [];
    return own.concat((part.parts || []).flatMap((item) => collect(item, mimeType)));
  };
  const plain = collect(payload, "text/plain").join("\n");
  const html = plain ? "" : collect(payload, "text/html").join("\n")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
  return {
    from: headers.from || null,
    replyTo: headers["reply-to"] || null,
    to: headers.to || null,
    cc: headers.cc || null,
    subject: headers.subject || null,
    date: headers.date || null,
    messageId: headers["message-id"] || null,
    references: headers.references || null,
    body: (plain || html).replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim().slice(0, 100_000),
  };
}
