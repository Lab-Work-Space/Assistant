import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secrets.js';

const key = randomBytes(32);

describe('secrets', () => {
  it('roundtrip', () => {
    const enc = encryptSecret('sk-test-123', key, 'openai');
    expect(enc.iv).toHaveLength(12);
    expect(enc.tag).toHaveLength(16);
    expect(enc.ciphertext.toString('utf8')).not.toContain('sk-test');
    expect(decryptSecret(enc, key, 'openai')).toBe('sk-test-123');
  });
  it('uses a fresh iv per call', () => {
    expect(encryptSecret('x', key, 'a').iv.equals(encryptSecret('x', key, 'a').iv)).toBe(false);
  });
  it('tampered tag throws', () => {
    const enc = encryptSecret('secret', key, 'a');
    enc.tag[0] = enc.tag[0]! ^ 0xff;
    expect(() => decryptSecret(enc, key, 'a')).toThrow();
  });
  it('ciphertext of provider a fails to decrypt as b', () => {
    const enc = encryptSecret('secret', key, 'a');
    expect(() => decryptSecret(enc, key, 'b')).toThrow();
  });
  it('wrong key throws and non-32-byte key is rejected', () => {
    const enc = encryptSecret('secret', key, 'a');
    expect(() => decryptSecret(enc, randomBytes(32), 'a')).toThrow();
    expect(() => encryptSecret('s', randomBytes(16), 'a')).toThrow(/32/);
  });
});
