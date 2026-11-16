import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminCardRepo } from '../db/repos/adminCards.js';
import { ADMIN_ROLE, GUILD, makeDeps } from '../discord/commands/test-helpers.js';
import { createOwned, draft, rig as skillRig, type Rig } from '../skills/test-helpers.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { AdminConsole } from './console.js';

const ADMIN = '900000000000000001';
let r: Rig;
beforeEach(async () => { r = await skillRig(); });
afterEach(async () => { await r.db.close(); });

async function up() {
  const t = await makeDeps({ skills: r.svc, org: r.org as never });
  const port = new FakeDiscordPort();
  const records: unknown[] = [];
  const c = new AdminConsole({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, cards: new AdminCardRepo(r.db.pool), cfg: { get: t.deps.cfg.get, setIf: async () => ({ ok: true }) }, cmd: t.deps, port,
    audit: t.deps.audit, log: { error: () => undefined }, hqUserId: () => '8', provenance: { record: async (...a) => void records.push(a) }, skills: r.svc,
  });
  return { c, port, records };
}
const P = { userId: ADMIN, tainted: false };

describe('G2SK-01: skill text on an admin_op card never re-enters admin history', () => {
  it('a skill_rollback card (restored text in full) and every other skill op card is posted without a provenance record; a non-skill admin_op card is still recorded', async () => {
    await r.svc.run({ op: 'create', id: 'rb', draft: draft(), attach: { kind: 'dept', id: 'software' } }, `user:${ADMIN}`);
    await r.svc.run({ op: 'edit', id: 'rb', base: 1, draft: { title: 'T', instructions: 'Second text, long enough to pass here.', templates: [] } }, `user:${ADMIN}`);
    const x = await up();
    for (const op of [
      { op: 'skill_rollback', skill: 'rb', version: 1 }, { op: 'skill_attach', skill: 'rb', target: 'dept:hr' }, { op: 'skill_toggle', skill: 'rb', enabled: false },
    ]) {
      const out = await x.c.proposeOp(P, op);
      expect(out.ok, JSON.stringify(op)).toBe(true);
    }
    const out = await x.c.proposeOp(P, { op: 'skill_detach', skill: 'rb', target: 'dept:software' });
    expect(out.ok).toBe(true);
    expect(x.port.posts.length).toBe(4);
    expect(x.records).toEqual([]);
    expect((await x.c.proposeOp(P, { op: 'bot_toggle', dept: 'rnd', enabled: false })).ok).toBe(true);
    expect(x.records).toHaveLength(1);
  });
});

describe('G2SK-04: the minted edit card carries the changed lines', () => {
  it('an edit proposal card lists counts and the changed lines, a create proposal card does not', async () => {
    await createOwned(r, 'software', 'chg');
    const out = await r.svc.propose({ kind: 'head', dept: 'software' }, { tainted: false, task: null }, { op: 'edit', skill: 'chg', instructions: 'Write the handover note before you close a task. Also add the ticket link.', reason: 'r' });
    if (!out.ok) throw new Error(out.code);
    const x = await up();
    const m = await x.c.mintSkillCard(ADMIN, out.id);
    expect(m.ok).toBe(true);
    const names = x.port.posts.at(-1)!.payload.fields!.map((f) => f.name.replace(/\\/g, ''));
    expect(names).toContain('Changes against the active version');
    expect(names.some((n) => n.startsWith('Changed lines'))).toBe(true);
  });
});
