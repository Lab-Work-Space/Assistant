import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { ADMIN_ROLE, GUILD, cmd } from '../../discord/commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps } from '../../discord/praw/index.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { chatRig, chunks, silence, TEXT, tone, until, VC2 } from './test-helpers.js';

// The CommonJS fs objects every `node:fs` / `fs/promises` import resolves to; syncBuiltinESMExports pushes the spies to ESM bindings.
const req = createRequire(import.meta.url);
const fs = req('node:fs') as Record<string, unknown>;
const fsp = req('node:fs/promises') as Record<string, unknown>;
const WRITES = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'open', 'openSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync', 'rename', 'renameSync'];
const P_WRITES = ['writeFile', 'appendFile', 'open', 'mkdir', 'mkdtemp', 'copyFile', 'rename'];
const writes: string[] = [];
const saved: [Record<string, unknown>, string, unknown][] = [];
let spying = false;
beforeAll(() => {
  for (const [obj, names, tag] of [[fs, WRITES, 'fs'], [fsp, P_WRITES, 'fsp']] as const) {
    for (const n of names) {
      const orig = obj[n] as (...a: unknown[]) => unknown;
      if (typeof orig !== 'function') continue;
      saved.push([obj, n, orig]);
      obj[n] = function (this: unknown, ...a: unknown[]) {
        if (spying) writes.push(`${tag}.${n} ${String(a[0])}`);
        return orig.apply(this, a);
      };
    }
  }
  syncBuiltinESMExports();
});
afterAll(() => {
  for (const [obj, n, orig] of saved) obj[n] = orig;
  syncBuiltinESMExports();
});

function deps(t: ReturnType<typeof chatRig>) {
  const cfg = new FakeConfig();
  return prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate: new PrawRateLimit(cfg, () => 0), ask: vi.fn() as never,
    audit: async () => {}, log: { error: () => undefined }, reminders: {} as never, schedules: {} as never, clock: () => 0, voiceChat: t.chat,
  });
}
const voiceCmd = (sub: string, userId = 'u1') => cmd('voice', sub, { channelId: TEXT, roles: [], userId });

describe('privacy', () => {
  it('join announces in channel; no fs write calls during a session (fs spy)', async () => {
    const t = chatRig();
    writes.length = 0;
    spying = true;
    try {
      const i = voiceCmd('join');
      const r = await handlePrawInteraction(i, deps(t));
      expect(r?.ephemeral).toBe(false); // public: everyone in the text channel sees it
      expect(r?.content).toContain('พราวเข้าห้องเสียงแล้ว เสียงของคนที่พูดจะถูกส่งไป Google เพื่อถอดเสียง');
      expect(r?.content).toMatch(/Microsoft/);
      const row = (r as { components?: { components: { custom_id: string }[] }[] }).components?.[0]?.components[0];
      expect(row?.custom_id).toMatch(/^voice:optin:[0-9a-f-]{36}$/);
      t.session()!.speak('u1', chunks(tone(600), silence(900)));
      await until(() => t.session()!.overlays.length === 1);
      await handlePrawInteraction(voiceCmd('leave'), deps(t));
    } finally {
      spying = false;
    }
    expect(writes).toEqual([]);
  });

  it('one voice channel at a time', async () => {
    const t = chatRig();
    const d = deps(t);
    expect((await handlePrawInteraction(voiceCmd('join'), d))?.ephemeral).toBe(false);
    t.where.set('u3', VC2);
    const second = voiceCmd('join', 'u3');
    await handlePrawInteraction(second, d);
    const refusal = second.followUps[0] ?? second.edits[0];
    expect(refusal?.ephemeral).toBe(true);
    expect(refusal?.content).toMatch(/already in a voice channel/i);
    expect(t.sessions).toHaveLength(1);
    await t.chat.leave();
  });
});
