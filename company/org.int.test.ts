import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../db/repos/index.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../prompts/index.js';
import { Org, PRAW_DEFAULT_MODEL, SEED_DEPARTMENTS, SEED_PERSONAS, seed, syncChannelMap } from './index.js';

let db: TestDb;
const prompts = loadPrompts(PROMPTS_DIR);
const repos = () => ({
  departments: new DepartmentRepo(db.pool),
  personas: new PersonaRepo(db.pool),
  channelMap: new ChannelMapRepo(db.pool),
});

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(async () => {
  await db.close();
});

const cat = (id: string, name: string) => ({ id, name, parentId: null, type: 4 });
const ch = (id: string, name: string, parentId: string | null, type = 0) => ({ id, name, parentId, type });

describe('seed', () => {
  it('seed is idempotent and keeps edited persona name', async () => {
    const r = repos();
    await seed(r, prompts);
    await seed(r, prompts);
    expect(await r.departments.list()).toHaveLength(10);
    expect(await r.personas.list()).toHaveLength(10);
    const sa = (await r.personas.get('system-analyst'))!;
    expect(sa).toMatchObject({ deptId: 'software', promptRef: 'members/system-analyst', directChannelId: '1565670817646256178', model: null });
    expect(sa.name).toBe(prompts.get('members/system-analyst')!.meta.name);
    expect((await r.departments.get('hq'))).toMatchObject({ model: null, color: 0xf1c40f, workChannelId: '1565652605290414160' });

    await r.personas.upsert({ ...sa, name: 'Edited Name', enabled: false });
    await r.departments.upsert({ ...(await r.departments.get('hq'))!, color: 1 });
    await seed(r, prompts);
    expect(await r.personas.get('system-analyst')).toMatchObject({ name: 'Edited Name', enabled: false });
    expect((await r.departments.get('hq'))!.color).toBe(1);
  });

  it('seed inserts praw (enabled, work channel null, provider gemini, model PRAW_DEFAULT_MODEL)', async () => {
    const r = repos();
    await seed(r, prompts);
    expect(await r.departments.get('praw')).toEqual({
      id: 'praw', name: 'พราว', categoryNamePattern: '', workChannelId: null, color: 0xf48fb1,
      provider: 'gemini', model: PRAW_DEFAULT_MODEL, enabled: true,
    });
    expect(PRAW_DEFAULT_MODEL).toMatch(/^gemini-[\w.-]*flash[\w.-]*$/);
    expect(PRAW_DEFAULT_MODEL).not.toMatch(/preview|exp/);
  });

  it('seed never overwrites an edited praw row', async () => {
    const r = repos();
    await seed(r, prompts);
    await r.departments.upsert({ ...(await r.departments.get('praw'))!, model: 'gemini-custom', enabled: false, color: 1 });
    await seed(r, prompts);
    expect(await r.departments.get('praw')).toMatchObject({ model: 'gemini-custom', enabled: false, color: 1 });
  });

  it('seed tables match the brief', () => {
    expect(SEED_DEPARTMENTS.map((d) => d.id)).toEqual(['hq', 'rnd', 'software', 'it', 'marketing', 'sales', 'hr', 'finance', 'ops', 'praw']);
    expect(Object.keys(SEED_PERSONAS)).toHaveLength(10);
  });
});

describe('syncChannelMap', () => {
  const guild = [
    cat('c-welcome', '👏 Welcomes & Announcement'),
    cat('c-hq', '🏢 Headquarter'),
    cat('c-rnd', '🔬 R&D Innovation'),
    cat('c-sw', '💻 Software House'),
    cat('c-hr', '🏢 HR - MANAGEMENT'),
    cat('c-fin', '💰 FINANCE & ACCOUNTING'),
    cat('c-mkt', '📈 MARKETING MANAGEMENT'),
    cat('c-sales', '🤝 SALES & PIPELINE'),
    cat('c-it', '💻 IT GENERAL & INFRASTRUCTURE'),
    cat('c-ops', '⚙️ OPERATIONS MANAGEMENT'),
    cat('c-bot', '🤖 BOT'),
    cat('c-logs', '📢Logs'),
    ch('w1', 'welcome', 'c-welcome'),
    ch('sw1', 'dev', 'c-sw'),
    ch('sw2', 'review', 'c-sw'),
    ch('it1', 'infra', 'c-it'),
    ch('hq1', 'goals', 'c-hq'),
    ch('b1', 'sa', 'c-bot'),
    ch('l1', 'log', 'c-logs'),
    ch('1565715069969502310', 'system-credentials', 'c-it'),
    ch('1565649677280485457', 'moderator-only', 'c-hq'),
    ch('thread-cred', 'secret-thread', '1565715069969502310', 11),
    ch('orphan', 'no-parent', null),
  ];

  it('syncChannelMap maps channels under "💻 Software House" to software and skips denied ids', async () => {
    const r = repos();
    await seed(r, prompts);
    const n = await syncChannelMap(guild, r);
    const map = new Map((await r.channelMap.list()).map((m) => [m.channelId, m.deptId]));
    expect(map.get('sw1')).toBe('software');
    expect(map.get('sw2')).toBe('software');
    expect(map.get('it1')).toBe('it');
    expect(map.get('hq1')).toBe('hq');
    expect(map.has('1565715069969502310')).toBe(false);
    expect(map.has('1565649677280485457')).toBe(false);
    expect(map.has('thread-cred')).toBe(false);
    for (const id of ['w1', 'b1', 'l1', 'orphan', 'c-sw']) expect(map.has(id)).toBe(false);
    expect(n).toBe(4);
    expect(await syncChannelMap(guild, r)).toBe(0);
  });

  it('TW10: syncChannelMap never maps the goals forum or goals channel, even under Headquarter; other forums map as usual', async () => {
    const r = repos();
    await seed(r, prompts);
    await syncChannelMap([cat('c-hq2', 'Headquarter'), ch('1565652418383847514', 'company-goals', 'c-hq2', 15), ch('1565651009076985956', 'goals', 'c-hq2'), ch('1566366032094961705', 'warroom', 'c-hq2'), ch('hq-forum', 'ideas', 'c-hq2', 15)], r);
    const map = new Map((await r.channelMap.list()).map((m) => [m.channelId, m.deptId]));
    expect(map.get('hq-forum')).toBe('hq');
    for (const id of ['1565652418383847514', '1565651009076985956', '1566366032094961705']) expect(map.has(id)).toBe(false);
  });

  it('syncChannelMap skips praw (empty pattern)', async () => {
    const r = repos();
    await seed(r, prompts);
    await syncChannelMap([cat('c-praw', 'Praw'), cat('c-empty', ''), ch('p1', 'chat', 'c-praw'), ch('p2', 'x', 'c-empty')], r);
    const map = await r.channelMap.list();
    expect(map.filter((m) => m.deptId === 'praw')).toEqual([]);
    expect(map.find((m) => m.channelId === 'p1' || m.channelId === 'p2')).toBeUndefined();
  });

  it('syncChannelMap never overwrites an existing mapping', async () => {
    const r = repos();
    await r.channelMap.upsert({ channelId: 'sw1', deptId: 'ops', isWork: false });
    await syncChannelMap(guild, r);
    expect((await r.channelMap.get('sw1'))!.deptId).toBe('ops');
  });

  it('marks the dept work channel as is_work', async () => {
    const r = repos();
    await r.channelMap.delete('hq1');
    await syncChannelMap([cat('c-hq', 'Headquarter'), ch('1565652605290414160', 'goals', 'c-hq')], r);
    expect(await r.channelMap.get('1565652605290414160')).toMatchObject({ deptId: 'hq', isWork: true });
  });
});

describe('Org', () => {
  const head = (dept: string) => ({ kind: 'head', dept }) as never;
  const pers = (personaId: string) => ({ kind: 'persona', personaId }) as const;

  it('lookups', async () => {
    const r = repos();
    await r.channelMap.upsert({ channelId: 'sw1', deptId: 'software', isWork: false });
    const org = await Org.load(r, prompts);
    expect(org.heads()).toHaveLength(10);
    expect(org.dept('software')!.id).toBe('software');
    expect(org.personasOf('software').map((p) => p.id)).toContain('code-reviewer-qa');
    expect(org.persona('legal-and-contracts')!.deptId).toBe('hq');
    expect(org.deptOfChannel('sw1')).toBe('software');
    expect(org.deptOfChannel('1565670817646256178')).toBe('software');
    expect(org.deptOfChannel('1565652605290414160')).toBe('hq');
    expect(org.deptOfChannel('nope')).toBeNull();
    expect(org.personaByDirectChannel('1565670817646256178')!.id).toBe('system-analyst');
    expect(org.personaByName('software', 'edited NAME')!.id).toBe('system-analyst');
    expect(org.personaByName('hq', 'Edited Name')).toBeNull();
    expect(org.toolsFor(pers('system-analyst'))).toEqual(prompts.get('members/system-analyst')!.meta.tools);
    expect(org.toolsFor(head('hq'))).toEqual(prompts.get('heads/hq')!.meta.tools);
  });

  it('reload picks up edits', async () => {
    const r = repos();
    const org = await Org.load(r, prompts);
    await r.personas.upsert({ ...(await r.personas.get('system-analyst'))!, name: 'Renamed' });
    expect(org.persona('system-analyst')!.name).not.toBe('Renamed');
    await org.reload();
    expect(org.persona('system-analyst')!.name).toBe('Renamed');
  });

  it('canDelegate: persona cannot delegate to other dept head', async () => {
    const org = await Org.load(repos(), prompts);
    expect(org.canDelegate(pers('system-analyst'), head('marketing'))).toBe(false);
    expect(org.canDelegate(pers('system-analyst'), head('software'))).toBe(true);
    expect(org.canDelegate(pers('system-analyst'), pers('code-reviewer-qa'))).toBe(false);
    expect(org.canDelegate(pers('system-analyst'), pers('system-analyst'))).toBe(false);
    expect(org.canDelegate(pers('nope'), head('software'))).toBe(false);
  });

  it('canDelegate: software head can delegate to marketing head', async () => {
    const org = await Org.load(repos(), prompts);
    expect(org.canDelegate(head('software'), head('marketing'))).toBe(true);
    expect(org.canDelegate(head('software'), pers('code-reviewer-qa'))).toBe(true);
    expect(org.canDelegate(head('software'), pers('legal-and-contracts'))).toBe(false);
    expect(org.canDelegate(head('software'), head('software'))).toBe(false);
    expect(org.canDelegate(head('hq'), head('ops'))).toBe(true);
    expect(org.canDelegate(head('hq'), pers('ceo-business-advisor'))).toBe(true);
    expect(org.canDelegate(head('hq'), pers('system-analyst'))).toBe(false);
  });
});
