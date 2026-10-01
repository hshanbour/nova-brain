import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_VERSION = 1;

export function decodeGmailEncryptionKey(value) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("NOVA_GMAIL_TOKEN_ENCRYPTION_KEY is required for Gmail.");
  const trimmed = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32)
    throw new Error("NOVA_GMAIL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function createTokenCipher({ key, randomBytesImpl = randomBytes }) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new TypeError("Gmail token encryption requires a 32-byte key.");

  return Object.freeze({
    encrypt(plaintext) {
      if (typeof plaintext !== "string" || !plaintext)
        throw new TypeError("Only non-empty Gmail secrets can be encrypted.");
      const iv = randomBytesImpl(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return Object.freeze({
        version: KEY_VERSION,
        algorithm: ALGORITHM,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      });
    },
    decrypt(envelope) {
      if (
        envelope?.version !== KEY_VERSION ||
        envelope?.algorithm !== ALGORITHM ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      )
        throw new Error("The stored Gmail credential envelope is invalid.");
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  });
}
