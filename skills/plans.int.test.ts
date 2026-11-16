import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planOp } from '../admin/ops.js';
import { isError } from '../discord/commands/plans.js';
import type { GrantEnv } from '../tools/skill-grant.js';
import { SkillRefused } from './service.js';
import { planSkillAttach, planSkillDetach, planSkillRollback, planSkillToggle } from './plans.js';
import { ADMIN, draft, rig, type Rig } from './test-helpers.js';

const BY = `user:${ADMIN}`;
let r: Rig;
let env: { allowed: Set<string> };
beforeEach(async () => {
  env = { allowed: new Set(['clickup_create_task', 'web_search']) };
  const grant: GrantEnv = { registered: () => [...env.allowed], builtins: () => [], kindOf: () => 'write' };
  r = await rig({ grant });
});
afterEach(async () => { await r.db.close(); });
const deps = () => ({ skills: r.svc, org: r.org });
const mk = async (id: string, tools: string[] = [], attach?: { kind: 'dept' | 'persona'; id: string }) =>
  r.svc.run({ op: 'create', id, draft: draft({ tools }), ...(attach ? { attach } : {}) }, BY);
const versions = async (id: string) => Number((await r.db.pool.query('SELECT count(*)::int AS n FROM skill_versions WHERE skill_id = $1', [id])).rows[0].n);

describe('compare-and-swap in SQL (SK9)', () => {
  it('two concurrent edits on one base version give exactly one new version', async () => {
    await mk('race');
    const edit = (text: string) => r.svc.run({ op: 'edit', id: 'race', base: 1, draft: { title: 'Race', instructions: `${text} and more words to be long enough.`, templates: [] } }, BY);
    const out = await Promise.allSettled([edit('First writer'), edit('Second writer')]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(SkillRefused);
    expect((lost.reason as SkillRefused).code).toBe('stale');
    expect(await versions('race')).toBe(2);
    expect((await r.repo.get('race'))!.activeVersion).toBe(2);
  });

  it('a detach between plan and run is refused and a second run writes nothing', async () => {
    await mk('det', [], { kind: 'dept', id: 'software' });
    const plan = await planSkillDetach('det', 'dept:software', deps(), BY);
    if (isError(plan)) throw new Error(plan.error);
    await r.svc.run({ op: 'detach', id: 'det', kind: 'dept', target: 'software' }, BY); // someone else detaches first
    await expect(plan.run!()).rejects.toBeInstanceOf(SkillRefused);
    expect((await r.repo.attachmentsOf('det'))).toEqual([]);
  });

  it('an attach planned against version 1 is refused when the skill moved to version 2 meanwhile', async () => {
    await mk('mv');
    const plan = await planSkillAttach('mv', 'dept:software', undefined, deps(), BY);
    if (isError(plan)) throw new Error(plan.error);
    await r.svc.run({ op: 'edit', id: 'mv', base: 1, draft: { title: 'T', instructions: 'Edited before the attach ran, long enough.', templates: [] } }, BY);
    await expect(plan.run!()).rejects.toMatchObject({ code: 'stale' });
    expect(await r.repo.attachmentsOf('mv')).toEqual([]);
  });

  it('a disable and an enable compare the status they planned against', async () => {
    await mk('tg', [], { kind: 'dept', id: 'software' });
    const off = await planSkillToggle('tg', false, deps(), BY);
    if (isError(off)) throw new Error(off.error);
    await off.run!();
    expect(r.org.skillsFor({ kind: 'head', dept: 'software' })).toEqual([]);
    expect(await planSkillToggle('tg', false, deps(), BY)).toMatchObject({ error: expect.stringContaining('Nothing would change') });
    const stale = await planSkillToggle('tg', true, deps(), BY);
    if (isError(stale)) throw new Error(stale.error);
    await r.svc.run({ op: 'status', id: 'tg', base: 1, from: 'disabled', to: 'active' }, BY);
    await expect(stale.run!()).rejects.toMatchObject({ code: 'stale' });
  });
});

describe('risk and the tool grant at write time and at apply (SK8, SK14)', () => {
  it('an attach that adds a tool to an actor sets risk and lists the tool delta; a tool-free attach does not', async () => {
    await mk('withtool', ['clickup_create_task']);
    await mk('plain');
    const risky = await planSkillAttach('withtool', 'dept:marketing', undefined, deps(), BY);
    if (isError(risky)) throw new Error(risky.error);
    expect(risky.risk).toBe(true);
    expect(risky.items.some((i) => i.label === 'Tools gained' && i.neu.includes('clickup_create_task') && i.neu.includes('head:marketing'))).toBe(true);
    const calm = await planSkillAttach('plain', 'dept:marketing', undefined, deps(), BY);
    if (isError(calm)) throw new Error(calm.error);
    expect(calm.risk).toBe(false);
    await risky.run!();
    expect(r.org.skillsFor({ kind: 'head', dept: 'marketing' }).map((s) => s.id)).toEqual(['withtool']);
  });

  it('through admin_op_propose planning: the four ops plan, risk follows the tool delta', async () => {
    await mk('viaop', ['web_search']);
    const od = { cmd: { ...deps() } as never, by: BY, channels: async () => [] };
    const a = await planOp({ op: 'skill_attach', skill: 'viaop', target: 'persona:system-analyst' }, od);
    if (isError(a)) throw new Error(a.error);
    expect(a.risk).toBe(true);
    expect(await planOp({ op: 'skill_attach', skill: 'viaop', target: 'dept:nowhere' }, od)).toMatchObject({ error: expect.stringContaining('existing department') });
    expect(await planOp({ op: 'skill_attach', skill: 'ghost', target: 'dept:hr' }, od)).toMatchObject({ error: 'Unknown skill.' });
  });

  it('attach is refused when a stored tool no longer passes rule G (never stripped silently)', async () => {
    await mk('gone', ['web_search']);
    env.allowed.delete('web_search'); // the tool was unregistered or the rule changed
    const plan = await planSkillAttach('gone', 'dept:hr', undefined, deps(), BY);
    expect(plan).toMatchObject({ error: expect.stringContaining('tool_not_allowed') });
  });

  it('a rollback to a version whose tool now fails G is refused at plan and again at apply', async () => {
    await mk('rb', ['web_search'], { kind: 'dept', id: 'software' });
    await r.svc.run({ op: 'tools', id: 'rb', base: 1, action: 'remove', tool: 'web_search' }, BY); // v2 without the tool
    const plan = await planSkillRollback('rb', 1, deps(), BY);
    if (isError(plan)) throw new Error(plan.error);
    expect(plan.risk).toBe(true);
    // the card shows the restored text in full, in plain fields
    expect(plan.items.some((i) => i.plain?.includes('Write the handover note'))).toBe(true);
    env.allowed.delete('web_search');
    expect(await planSkillRollback('rb', 1, deps(), BY)).toMatchObject({ error: expect.stringContaining('tool_not_allowed') });
    await expect(plan.run!()).rejects.toMatchObject({ code: 'tool_not_allowed' });
    expect(await versions('rb')).toBe(2);
    expect((await r.repo.get('rb'))!.tools).toEqual([]);
  });

  it('a rollback inserts a copy as the next version (source rollback, restored_from) and moves the active version', async () => {
    await mk('rb2');
    await r.svc.run({ op: 'edit', id: 'rb2', base: 1, draft: { title: 'Handover checklist', instructions: 'A second text that is long enough to pass.', templates: [] } }, BY);
    const plan = await planSkillRollback('rb2', 1, deps(), BY);
    if (isError(plan)) throw new Error(plan.error);
    await plan.run!();
    const row = await r.repo.get('rb2');
    expect(row).toMatchObject({ activeVersion: 3, instructions: expect.stringContaining('Write the handover note') });
    expect((await r.db.pool.query("SELECT source, restored_from FROM skill_versions WHERE skill_id = 'rb2' AND version = 3")).rows[0]).toEqual({ source: 'rollback', restored_from: 1 });
  });

  it('G is enforced at create and at tools add: a SENSITIVE, builtin or unregistered name is refused', async () => {
    env.allowed.add('github_create_branch');
    await expect(mk('bad1', ['github_create_branch'])).rejects.toMatchObject({ code: 'tool_not_allowed' });
    await expect(mk('bad2', ['not_registered'])).rejects.toMatchObject({ code: 'tool_not_allowed' });
    await mk('ok1');
    await expect(r.svc.run({ op: 'tools', id: 'ok1', base: 1, action: 'add', tool: 'skill_propose' }, BY)).rejects.toMatchObject({ code: 'tool_not_allowed' });
    await r.svc.run({ op: 'tools', id: 'ok1', base: 1, action: 'add', tool: 'web_search' }, BY);
    expect((await r.repo.get('ok1'))!.tools).toEqual(['web_search']);
  });
});

describe('audit and refusal text carry codes only (SK15)', () => {
  it('a refused write is audited with a code, never with text', async () => {
    await mk('au');
    await expect(r.svc.run({ op: 'edit', id: 'au', base: 9, draft: { title: 'ZZMARKERZZ', instructions: 'ZZMARKERZZ long enough text here.', templates: [] } }, BY)).rejects.toBeInstanceOf(SkillRefused);
    expect(JSON.stringify(r.audits)).not.toContain('ZZMARKERZZ');
    expect(r.audits.at(-1)).toMatchObject({ action: 'skill.edit', tool: 'au', outcome: 'refused:stale' });
    await r.svc.run({ op: 'tools', id: 'au', base: 1, action: 'add', tool: 'web_search' }, BY);
    expect(r.audits.at(-1)).toMatchObject({ action: 'skill.tools.add', outcome: 'ok v2 web_search' });
  });
});
