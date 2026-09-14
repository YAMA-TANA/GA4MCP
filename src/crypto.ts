import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

const key = Buffer.from(config.encryptionKeyBase64, "base64");
if (key.length !== 32) {
  throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((x) => x.toString("base64url")).join(".");
}

export function decryptSecret(encoded: string): string {
  const [ivRaw, tagRaw, cipherRaw] = encoded.split(".");
  if (!ivRaw || !tagRaw || !cipherRaw) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
