import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PREFIX = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error(`secretbox: key must be ${KEY_BYTES * 2} hex chars, got ${keyHex.length}`);
    }
    this.key = Buffer.from(keyHex, "hex");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${iv.toString("hex")}:${ciphertext.toString("hex")}:${tag.toString("hex")}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split(":");
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw new Error("secretbox: malformed payload, expected v1:<iv_hex>:<ciphertext_hex>:<tag_hex>");
    }
    const [_, ivHex, ctHex, tagHex] = parts;
    if (!/^[0-9a-fA-F]*$/.test(ivHex) || !/^[0-9a-fA-F]*$/.test(ctHex) || !/^[0-9a-fA-F]*$/.test(tagHex)) {
      throw new Error("secretbox: payload segments must be hex");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("secretbox: decryption failed (wrong key or corrupted payload)");
    }
  }
}

export function ensureKeyFile(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const keyHex = randomBytes(KEY_BYTES).toString("hex");
  writeFileSync(path, keyHex + "\n", "utf8");
  return keyHex;
}
