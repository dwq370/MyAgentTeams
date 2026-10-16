import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";

function keyFrom(secret: string): Buffer {
  return scryptSync(secret, "agentteam", 32);
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(payload: string, secret: string): string {
  const [iv, tag, data] = payload.split(".");
  if (!iv || !tag || !data) throw new Error("凭证格式无效");
  const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function secretHint(plain: string): string {
  const tail = plain.slice(-4);
  return `••••${tail}`;
}
