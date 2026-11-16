import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../../config/secrets.js';
import { handleInteraction } from './index.js';
import { interaction, makeDeps, MASTER_KEY, text } from './test-helpers.js';

const KEY = 'AIzaSyFAKE-test-key-0123456789abcdefgh';

describe('/provider add gemini', () => {
  it('add gemini stores ciphertext (AAD "gemini") and reply says restart', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(interaction({ kind: 'modal', customId: 'provider-add:gemini', fields: { key: KEY } }), t.deps);
    const stored = t.mem.keys.get('gemini')!;
    expect(stored.ciphertext.toString('utf8')).not.toContain(KEY);
    expect(decryptSecret(stored, MASTER_KEY, 'gemini')).toBe(KEY);
    expect(() => decryptSecret(stored, MASTER_KEY, 'claude')).toThrow();
    expect(text(r)).not.toContain(KEY);
    expect(text(r).toLowerCase()).toContain('restart');
  });

  it('other providers keep the plain reply', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(interaction({ kind: 'modal', customId: 'provider-add:openai', fields: { key: KEY } }), t.deps);
    expect(text(r).toLowerCase()).not.toContain('restart');
  });
});
