import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IGNORED_CHANNEL_IDS } from '../company/router.js';
import { BOT_LOG_CHANNEL_ID } from '../company/channels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '.claude', 'tests'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'test-helpers.ts' && !name.endsWith('-fixture.ts')) out.push(p);
  }
  return out;
}

describe('#🧾-bot-log stays out of every model context (Gate 1 S29)', () => {
  it('is an ignored channel: never routed, never mappable', () => {
    expect(IGNORED_CHANNEL_IDS).toContain(BOT_LOG_CHANNEL_ID);
  });
  it('no source line reads history or messages with the bot-log channel id', () => {
    const offenders = sources(ROOT).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, l, i })))
      .filter(({ l }) => /BOT_LOG_CHANNEL_ID/.test(l) && /\b(history|fetchHistory|recentMessages)\s*\(|messages\s*\.\s*fetch\s*\(/.test(l.replace(/\/\/.*$/, '')))
      .map(({ f, i }) => `${relative(ROOT, f)}:${i + 1}`);
    expect(offenders).toEqual([]);
  });
  it('the executor\'s own reads of messages are bounded to the one channel an op names, never the bot-log (a protected channel)', async () => {
    const { checkServerOps } = await import('../discord/server/server-limits.js');
    const { fakeServerWorld, serverConsts, serverIn } = await import('../discord/server/server-fixture.js');
    const { C } = await import('../discord/test-helpers.js');
    const r = await checkServerOps([{ kind: 'msg.bulk', channel: C.botLog, count: 10 }], fakeServerWorld(), serverConsts(), serverIn());
    expect(r.ok).toBe(false);
  });
});
