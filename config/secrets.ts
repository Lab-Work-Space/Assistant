import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret { ciphertext: Buffer; iv: Buffer; tag: Buffer }

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('master key must be 32 bytes');
}

/** AES-256-GCM. `aad` (the provider id) binds the ciphertext to its row so it cannot be moved to another provider. */
export function encryptSecret(plain: string, key: Buffer, aad: string): EncryptedSecret {
  checkKey(key);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

export function decryptSecret(enc: EncryptedSecret, key: Buffer, aad: string): string {
  checkKey(key);
  const d = createDecipheriv('aes-256-gcm', key, enc.iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(enc.tag);
  return Buffer.concat([d.update(enc.ciphertext), d.final()]).toString('utf8');
}
