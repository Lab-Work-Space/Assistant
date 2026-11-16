import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildMessage } from '../discord/embeds/index.js';
import { helloFiles, zipOfFiles } from '../forge/test-helpers.js';
import { DECIDE_TEXT, REQUEST_TEXT, ReleaseService, type ReleaseDeps, type RunInfo } from './service.js';
import { FORGE_BUILDER_LINE, FORGE_HANDOFF_BODY, handoffNonce } from './targets.js';

/** R7 PLUGIN-FORGE BE2 (spec 3.3, 3.4, 5.6, 5.7; PF-C7, PF-C11 half, PF-C14; FG-AC09, FG-AC10, FG-AC11, FG-AC12 half). The install_plugin branches of ReleaseService with fake ports. */
const HEAD = { kind: 'head', dept: 'software' } as const;
const CONFIG = '1565682159375749161';
const SRC = '700000000000000001';
const THREAD = '700000000000000002';
const ADMIN = '900000000000000001';
const CARD_MSG = '800000000000000021';
const COPY_MSG = '800000000000000020';
const POSTED = '800000000000000030';
const TASK = '11111111-1111-1111-1111-111111111111';
const ROOT = 'abcdef01-2222-2222-2222-222222222222';
const TOKEN = 'a'.repeat(32);
const BASE = `sha256:${'1'.repeat(64)}`;
const ZIP = zipOfFiles(helloFiles());
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const SHA = sha(ZIP);
const EXPIRES = new Date('2026-12-01T00:00:00Z');
const FORGE = { id: 3, status: 'live', ideaId: 1, ideaName: 'hello', deptId: 'software' };
const PROJECT = { id: 5, title: 'Forge project', status: 'active', tainted: false };

const clean = (over: Partial<RunInfo> = {}): RunInfo => ({ tainted: false, task: { id: TASK, rootId: ROOT, tainted: false }, ownsTask: true, source: { channelId: SRC, threadId: THREAD }, ...over });
const INPUT = { slug: 'hello-ws', title: 'Hello plugin', summary: 'A hello plugin. It echoes.', target: 'install_plugin' as const };

const rowOf = (over: Record<string, unknown> = {}) => ({
  id: 7, token: TOKEN, deptId: 'software', requester: 'head:software', taskId: TASK, rootId: ROOT, projectId: 5, target: 'install_plugin', title: 'Hello plugin', summary: 'A hello plugin. It echoes.', slug: 'hello-ws',
  sha256: SHA, bytes: ZIP.length, files: 3, skipped: 0, evidence: { runs: [], writesAfterLastRun: null }, tainted: false, catalogDigest: 'd'.repeat(64), sourceChannelId: SRC, sourceThreadId: THREAD,
  status: 'pending', channelId: CONFIG, messageId: CARD_MSG, createdAt: new Date(), expiresAt: EXPIRES, decidedBy: null, decidedAt: null, reason: null, releasedMessageId: null, releasedAt: null, outcome: null, live: true,
  forgeId: 3, pluginSlug: 'hello', pluginManifestSha256: 'm'.repeat(64), ...over,
});

interface Over {
  forgeOn?: () => unknown; mcpOn?: () => unknown; halted?: boolean; failCopy?: boolean; failCard?: boolean; project?: unknown; forge?: unknown; cap?: string | null; taken?: boolean; zip?: Buffer; skipped?: number; noPort?: boolean;
  enqueue?: (b: unknown) => Promise<unknown>; post?: (...a: unknown[]) => Promise<string>; repo?: Record<string, unknown>; counts?: Record<string, number>; base?: string | null; secrets?: string[]; ideaName?: string;
}
function rig(o: Over = {}) {
  const calls: string[] = [];
  const audits: { actor: string; action: string; outcome?: string | null }[] = [];
  const cards: Record<string, unknown>[] = [];
  const posts: { actor: unknown; target: unknown; payload: Record<string, unknown>; opts: unknown }[] = [];
  const files: { target: unknown; file: { name: string; nonce?: string } }[] = [];
  const closed: { note: string }[] = [];
  const notices: { dept: string; text: string }[] = [];
  const track = <T>(name: string, f: (...a: never[]) => T) => vi.fn((...a: never[]) => { calls.push(name); return f(...a); });
  const zip = o.zip ?? ZIP;
  const repo = {
    openCounts: track('openCounts', async () => ({ tree: 0, dept: 0, total: 0, today: 0, ...o.counts })),
    window: track('window', async () => ({ since: '2026-01-01T00:00:00.000000Z', until: '2026-01-02T00:00:00.123456Z' })),
    evidence: track('evidence', async () => ({ runs: [], writesAfterLastRun: null })),
    create: track('create', async () => ({ ok: true as const, id: 7, expiresAt: EXPIRES })),
    setCard: track('setCard', async () => true),
    byToken: track('byToken', async () => rowOf()),
    byId: track('byId', async () => rowOf()),
    claim: track('claim', async () => ({ ...rowOf({ status: 'releasing', decidedBy: ADMIN }), zip })),
    revert: track('revert', async () => true),
    settleReleased: track('settleReleased', async () => true),
    fail: track('fail', async () => true),
    reject: track('reject', async () => rowOf({ status: 'rejected' })),
    rejectById: track('rejectById', async () => rowOf({ status: 'rejected' })),
    expire: track('expire', async () => []), failInterrupted: track('failInterrupted', async () => []), list: track('list', async () => []), now: track('now', async () => '2026-01-02T00:00:00.000000Z'),
    ...o.repo,
  };
  const forge = o.noPort ? undefined : {
    enabled: o.forgeOn ?? (() => true), mcpEnabled: o.mcpOn ?? (() => false), baseId: o.base === undefined ? BASE : o.base,
    forgeOf: track('forgeOf', async () => (o.forge === undefined ? { ...FORGE, ideaName: o.ideaName ?? FORGE.ideaName } : o.forge)),
    capCode: track('capCode', async () => o.cap ?? null),
    slugTaken: track('slugTaken', async () => o.taken ?? false),
    enqueue: track('enqueue', o.enqueue ?? (async () => ({ ok: true as const }))),
  };
  const deps = {
    repo, ws: { export: track('export', async () => ({ zip, files: 3, sha256: sha(zip), skipped: o.skipped ?? 0 })) },
    projects: { byRoot: track('byRoot', async () => (o.project === undefined ? PROJECT : o.project)) }, forge,
    enabled: () => true, wsEnabled: () => true, halted: () => o.halted ?? false, tz: () => 'Asia/Bangkok',
    audit: async (e: never) => void audits.push(e), secrets: o.secrets ?? [], configChannelId: CONFIG, catalogDigest: 'd'.repeat(64),
    postCard: track('postCard', async (p: Record<string, unknown>) => { if (o.failCard) throw new Error('boom'); cards.push(p); return CARD_MSG; }),
    postFile: track('postFile', async (_a: unknown, target: { channelId: string }, _p: unknown, file: { name: string; nonce?: string }) => {
      files.push({ target, file });
      if (target.channelId === CONFIG) { if (o.failCopy) throw new Error('boom'); return COPY_MSG; }
      return POSTED;
    }),
    post: track('post', async (actor: unknown, target: unknown, payload: Record<string, unknown>, opts: unknown) => { posts.push({ actor, target, payload, opts }); return o.post ? o.post(actor, target, payload, opts) : POSTED; }),
    provenance: { record: track('record', async () => undefined) },
    closeCard: async (_c: string, _m: string, note: string) => void closed.push({ note }),
    notifyHead: async (dept: string, text: string) => void notices.push({ dept, text }),
    log: { error: () => undefined }, newToken: () => TOKEN,
  } as unknown as ReleaseDeps;
  const svc = new ReleaseService(deps);
  const click = (action: 'approve' | 'reject' = 'approve') => svc.decide({ token: TOKEN, action, userId: ADMIN, channelId: CONFIG, messageId: CARD_MSG });
  return { svc, repo, forge, calls, audits, cards, posts, files, closed, notices, click };
}
const SIDE = ['openCounts', 'export', 'window', 'evidence', 'create', 'setCard', 'postFile', 'postCard'];

describe('install_plugin request: the refusal order (spec 3.3), audited, no export before step 9 (FG-AC09)', () => {
  const cases: [string, Over, Partial<RunInfo>, string, string][] = [
    ['forge off (false)', { forgeOn: () => false }, {}, 'forge_off', REQUEST_TEXT.forge_off],
    ['forge off (a read error)', { forgeOn: () => { throw new Error('x'); } }, {}, 'forge_off', REQUEST_TEXT.forge_off],
    ['forge off (not exactly true)', { forgeOn: () => 'true' }, {}, 'forge_off', REQUEST_TEXT.forge_off],
    ['forge off (no port at all)', { noPort: true }, {}, 'forge_off', REQUEST_TEXT.forge_off],
    ['not_forge (no project)', { project: null }, {}, 'not_forge', REQUEST_TEXT.not_forge],
    ['not_forge (project not active)', { project: { ...PROJECT, status: 'done' } }, {}, 'not_forge', REQUEST_TEXT.not_forge],
    ['not_forge (no forge row)', { forge: null }, {}, 'not_forge', REQUEST_TEXT.not_forge],
    ['not_forge (forge not live)', { forge: { ...FORGE, status: 'staged' } }, {}, 'not_forge', REQUEST_TEXT.not_forge],
    ['plugin_tainted (the run)', {}, { tainted: true }, 'plugin_tainted', REQUEST_TEXT.plugin_tainted],
    ['plugin_tainted (G2-FG-12: the forge project was proposed by a tainted run)', { project: { ...PROJECT, tainted: true } }, {}, 'plugin_tainted', REQUEST_TEXT.plugin_tainted],
    ['plugin_tainted (the task)', {}, { task: { id: TASK, rootId: ROOT, tainted: true } }, 'plugin_tainted', REQUEST_TEXT.plugin_tainted],
    ['forge_attempts', { cap: 'forge_attempts' }, {}, 'forge_attempts', 'This forge already had 3 builds.'],
    ['forge_day_cap', { cap: 'forge_day_cap' }, {}, 'forge_day_cap', '3 plugin builds were requested today; try again tomorrow.'],
    ['image_cap', { cap: 'image_cap' }, {}, 'image_cap', '8 built plugin images are kept already; a Bot Admin must disable unused servers.'],
    ['R5 count after the forge steps', { counts: { tree: 1 } }, {}, 'tree_pending', REQUEST_TEXT.tree_pending],
  ];
  for (const [name, o, run, code, text] of cases) {
    it(name, async () => {
      const r = rig(o);
      const res = await r.svc.request(HEAD, clean(run), INPUT);
      expect(res).toEqual({ ok: false, code, error: text });
      for (const s of SIDE.filter((x) => x !== 'openCounts')) expect(r.calls, s).not.toContain(s);
      expect(r.calls).not.toContain('create');
      expect(r.audits).toEqual([expect.objectContaining({ action: 'release.request', outcome: `refused:${code}` })]);
    });
  }
  it('forge_off is checked before not_forge, not_forge before plugin_tainted, plugin_tainted before the caps', async () => {
    expect((await rig({ forgeOn: () => false, project: null }).svc.request(HEAD, clean({ tainted: true }), INPUT))).toMatchObject({ code: 'forge_off' });
    expect((await rig({ project: null, cap: 'image_cap' }).svc.request(HEAD, clean({ tainted: true }), INPUT))).toMatchObject({ code: 'not_forge' });
    expect((await rig({ cap: 'image_cap' }).svc.request(HEAD, clean({ tainted: true }), INPUT))).toMatchObject({ code: 'plugin_tainted' });
    const r = rig({ cap: 'forge_attempts', counts: { tree: 1 } });
    expect((await r.svc.request(HEAD, clean(), INPUT))).toMatchObject({ code: 'forge_attempts' });
    expect(r.calls).not.toContain('openCounts');
  });
  it('the R5 steps still come first (not_software, halted, off, no_task, ws_off) for this target', async () => {
    expect(await rig({ forgeOn: () => false }).svc.request({ kind: 'head', dept: 'rnd' }, clean(), INPUT)).toMatchObject({ code: 'not_software' });
    expect(await rig({ forgeOn: () => false, halted: true }).svc.request(HEAD, clean(), INPUT)).toMatchObject({ code: 'halted' });
    expect(await rig({ forgeOn: () => false }).svc.request(HEAD, clean({ task: null }), INPUT)).toMatchObject({ code: 'no_task' });
  });
  it('a handoff request never reads the forge', async () => {
    const r = rig({ forgeOn: () => false });
    const res = await r.svc.request(HEAD, clean(), { ...INPUT, target: 'handoff' });
    expect(res.ok).toBe(true);
    expect(r.calls).not.toContain('forgeOf');
    expect(r.calls).not.toContain('enqueue');
  });
});

describe('install_plugin request: export, validation, create, card (spec 3.3 steps 9-11, 5.6)', () => {
  it('plugin_skipped when the export skipped anything', async () => {
    const r = rig({ skipped: 1 });
    expect(await r.svc.request(HEAD, clean(), INPUT)).toEqual({ ok: false, code: 'plugin_skipped', error: 'Some workspace files could not be exported; a plugin must export completely.' });
    expect(r.calls).toContain('export');
    expect(r.calls).not.toContain('create');
  });
  it('a validator failure is plugin_<code> with the fixed text (and a first path only when it passes rule P)', async () => {
    const f = helloFiles();
    f['Dockerfile'] = 'FROM scratch';
    const r = rig({ zip: zipOfFiles(f) });
    const res = await r.svc.request(HEAD, clean(), INPUT);
    expect(res).toMatchObject({ ok: false, code: 'plugin_layout' });
    expect((res as { error: string }).error).toContain('does not follow the plugin layout');
    expect((res as { error: string }).error).toContain('First: Dockerfile.');
    expect(r.audits.at(-1)).toMatchObject({ outcome: 'refused:plugin_layout' });
    expect(r.calls).not.toContain('create');
  });
  it('a forge.json that names another idea is plugin_idea_mismatch', async () => {
    const f = helloFiles();
    f['forge.json'] = f['forge.json']!.replace(/"idea":\s*1/, '"idea": 2');
    const res = await rig({ zip: zipOfFiles(f) }).svc.request(HEAD, clean(), INPUT);
    expect(res).toMatchObject({ ok: false, code: 'plugin_idea_mismatch' });
  });
  it('plugin_slug_taken when the slug of forge.json is used by a server (the check reads the forge.json slug, never the ws slug)', async () => {
    const r = rig({ taken: true });
    expect(await r.svc.request(HEAD, clean(), INPUT)).toEqual({ ok: false, code: 'plugin_slug_taken', error: 'That plugin slug is already used by an MCP server.' });
    expect(r.forge!.slugTaken).toHaveBeenCalledWith('hello', 3);
  });
  it('success: create carries the forge id, the forge.json slug and the manifest hash; the card follows the copy; the head text says nothing is installed', async () => {
    const r = rig();
    const res = await r.svc.request(HEAD, clean(), INPUT);
    expect(res).toMatchObject({ ok: true, id: 7 });
    const made = (r.repo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(made).toMatchObject({ target: 'install_plugin', forgeId: 3, pluginSlug: 'hello', slug: 'hello-ws', projectId: 5, tainted: false });
    expect(made.pluginManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.calls.indexOf('postFile')).toBeLessThan(r.calls.indexOf('postCard'));
    expect((res as { text: string }).text).toMatch(/NOTHING is built or installed yet/);
    expect(r.audits.some((a) => a.outcome === `#7 hello-ws ${SHA.slice(0, 16)}`)).toBe(true);
  });
  it('PF-C14: when the source copy could not be posted for install_plugin no card is posted (the row stays pending) and the head is told', async () => {
    const r = rig({ failCopy: true });
    const res = await r.svc.request(HEAD, clean(), INPUT);
    expect(res.ok).toBe(true);
    expect(r.calls).not.toContain('postCard');
    expect(r.repo.setCard).not.toHaveBeenCalled();
    expect((res as { text: string }).text).toMatch(/source copy could not be posted/);
    expect((res as { text: string }).text).toMatch(/no card was posted/i);
  });
  it('R5 is unchanged for a handoff: a failed copy still posts the card, saying the copy could not be posted', async () => {
    const r = rig({ failCopy: true });
    await r.svc.request(HEAD, clean(), { ...INPUT, target: 'handoff' });
    expect(r.calls).toContain('postCard');
    expect(String(r.cards[0]!.body)).toContain('Artefact copy: could not be posted here.');
  });
  it('the card: target line, forge line, plugin line, runtime line, the verbatim builder line, the mcp switch line, the R5 lines, and the four fields', async () => {
    const r = rig({ mcpOn: () => true });
    await r.svc.request(HEAD, clean(), INPUT);
    const body = String(r.cards[0]!.body);
    expect(body).toContain('Release #7 from the software head. Target: install_plugin (code builds an MCP server image from these exact bytes and stages it; nothing is installed until a Bot Admin runs /mcp approve after seeing the tools the built server reports).');
    expect(body).toContain('Forge #3 for tool idea #1 hello from software.');
    expect(body).toMatch(/Plugin hello "Hello plugin": \d+ shipped file\(s\), \d+ bytes, manifest [0-9a-f]{16}; \d+ other file\(s\) \(tests, notes\) are not shipped\./);
    expect(body).toContain('Runtime dependencies: none. Class: write (every call asks a Bot Admin). Departments: software. Network: none. Secrets: none.');
    expect(body).toContain(FORGE_BUILDER_LINE(BASE));
    expect(FORGE_BUILDER_LINE(BASE)).toBe('Build (fixed, by code): the shipped files are copied into the checked-in base image 111111111111 (Node 24, no npm) with docker create, cp and commit. Nothing from the plugin runs during the build and there is no network. The plugin cannot choose the base image, the user (65534), the entry point (node /srv/plugin/server.mjs), the class or a secret.');
    expect(body).toContain('External tools are switched on (mcp.enabled); staging works either way.');
    expect(body).toContain('Whether earlier runs that wrote these files read outside content is not tracked.');
    expect(body).toContain('Artefact copy: posted just above this card.');
    expect(body).toContain('Pinned:');
    expect(body).toContain('Tool catalog');
    expect(body).toContain('Expires <t:');
    const names = (r.cards[0]!.fields as { name: string; value: string }[]).map((f) => f.name);
    expect(names[0]).toContain('Summary');
    expect(names[1]).toContain('Evidence');
    expect(names[2]).toContain('Shipped files (listed by code: path, bytes, sha256 first 12)');
    expect(names[3]).toBe('Dev dependencies (not shipped; workspace tests only)');
    const shipped = (r.cards[0]!.fields as { value: string }[])[2]!.value;
    expect(shipped).toMatch(/server\.mjs/);
    expect(shipped).toMatch(/[0-9a-f]{12}/);
    expect(r.cards[0]!.releaseCardId).toBe(TOKEN);
  });
  it('the mcp switch line says off when mcp.enabled is off or unreadable', async () => {
    for (const mcpOn of [() => false, () => { throw new Error('x'); }]) {
      const r = rig({ mcpOn });
      await r.svc.request(HEAD, clean(), INPUT);
      expect(String(r.cards[0]!.body)).toContain('External tools are switched off (mcp.enabled); staging works either way.');
    }
  });
  it('with no base id the builder line says the base image is not set up (a spec gap: builds wait)', async () => {
    const r = rig({ base: null });
    await r.svc.request(HEAD, clean(), INPUT);
    expect(String(r.cards[0]!.body)).toContain('not set up yet');
  });
  it('a tainted-run note is impossible here (PF-C7); the card always carries the R5 untracked-writes line', async () => {
    const r = rig();
    await r.svc.request(HEAD, clean(), INPUT);
    expect(String(r.cards[0]!.body)).not.toContain('read outside content (tainted)');
  });
  it('FG-AC11: the worst-case install_plugin card is exactly one message with the buttons', async () => {
    const f = helloFiles();
    for (let i = 0; i < 40; i++) f[`src/file-with-a-long-name-${String(i).padStart(3, '0')}-${'x'.repeat(30)}.mjs`] = `export const v${i} = ${i};\n`;
    f['package.json'] = JSON.stringify({ name: 'hello', type: 'module', devDependencies: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`some-long-dev-dependency-name-${i}`, '^1.2.3'])) });
    f['package-lock.json'] = JSON.stringify({ name: 'hello', lockfileVersion: 3, packages: { '': { name: 'hello' } } });
    const r = rig({ zip: zipOfFiles(f), mcpOn: () => true, ideaName: 'a'.repeat(39) });
    const res = await r.svc.request(HEAD, clean(), { slug: 'b'.repeat(40), title: '*'.repeat(100), summary: '*'.repeat(600), target: 'install_plugin' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const msgs = buildMessage(r.cards[0] as never, { deptColor: 1, adminRoleId: 'a', dept: 'software' } as never);
    expect(msgs).toHaveLength(1);
    expect(JSON.stringify(msgs[0]!.components)).toContain(`relcard:${TOKEN}:approve`);
    const embeds = msgs[0]!.embeds as { title?: string; description?: string; fields?: { name: string; value: string }[] }[];
    const fields = embeds.flatMap((e) => e.fields ?? []);
    for (const x of fields) { expect(x.value.length).toBeLessThanOrEqual(1024); expect(x.name.length).toBeLessThanOrEqual(256); }
    const total = embeds.reduce((n, e) => n + (e.title ?? '').length + (e.description ?? '').length + (e.fields ?? []).reduce((m, x) => m + x.name.length + x.value.length, 0), 0);
    expect(total).toBeLessThanOrEqual(6000);
    for (const e of embeds) expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
    expect(String((r.cards[0]!.fields as { value: string }[])[2]!.value)).toMatch(/… and \d+ more \(see the artefact copy\)/);
  });
});

describe('install_plugin decide: the approve path (spec 3.4, FG-AC10, FG-AC12 half)', () => {
  it('forge off before the claim: `off`, the row stays pending, nothing enqueued', async () => {
    const r = rig({ forgeOn: () => false });
    expect(await r.click()).toEqual({ ok: false, code: 'off', text: DECIDE_TEXT.off });
    expect(r.calls).not.toContain('claim');
    expect(r.calls).not.toContain('enqueue');
    const th = rig({ forgeOn: () => { throw new Error('x'); } });
    expect(await th.click()).toMatchObject({ ok: false, code: 'off' });
  });
  it('G2-FG-09: a card whose forge is cancelled (or gone, or another forge, or whose project is no longer active) is refused `not_forge` with clear text; no claim, no enqueue, the row is never left released', async () => {
    const cases: [string, Over][] = [
      ['forge cancelled', { forge: { ...FORGE, status: 'cancelled' } }],
      ['forge installed', { forge: { ...FORGE, status: 'installed' } }],
      ['no forge row', { forge: null }],
      ['another forge of the project', { forge: { ...FORGE, id: 99 } }],
      ['project done', { project: { ...PROJECT, status: 'done' } }],
      ['project gone', { project: null }],
    ];
    for (const [why, o] of cases) {
      const r = rig(o);
      expect(await r.click(), why).toEqual({ ok: false, code: 'not_forge', text: DECIDE_TEXT.not_forge });
      expect(r.calls, why).not.toContain('claim');
      expect(r.calls, why).not.toContain('enqueue');
      expect(r.calls, why).not.toContain('settleReleased');
    }
    expect(DECIDE_TEXT.not_forge).toBe('This plugin forge was cancelled or its project is no longer active; nothing was built. Reject this card.');
    // a staged forge may still take a build; a live one does
    expect(await rig({ forge: { ...FORGE, status: 'staged' } }).click()).toMatchObject({ ok: true, result: 'released' });
  });
  it('a handoff row is not affected by the forge switch', async () => {
    const r = rig({ forgeOn: () => false, repo: { byToken: vi.fn(async () => rowOf({ target: 'handoff', forgeId: null, pluginSlug: null, pluginManifestSha256: null })), claim: vi.fn(async () => ({ ...rowOf({ target: 'handoff', status: 'releasing', decidedBy: ADMIN, forgeId: null, pluginSlug: null, pluginManifestSha256: null }), zip: ZIP })) } });
    expect(await r.click()).toMatchObject({ ok: true, result: 'released' });
  });
  it('approve: enqueue with the pinned bytes and the deciding admin, then the notice as the software head with the nonce, then settleReleased; never a file post, never an activation', async () => {
    const r = rig();
    const res = await r.click();
    expect(res).toMatchObject({ ok: true, result: 'released' });
    expect(r.forge!.enqueue).toHaveBeenCalledTimes(1);
    const b = (r.forge!.enqueue.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(b).toMatchObject({ releaseId: 7, forgeId: 3, pluginSlug: 'hello', sha256: SHA, bytes: ZIP.length, manifestSha256: 'm'.repeat(64), decidedBy: ADMIN });
    expect((b.zip as Buffer).equals(ZIP)).toBe(true);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({ actor: { kind: 'head', dept: 'software' }, target: { channelId: SRC, threadId: THREAD }, payload: { type: 'chat', noHandles: true, body: FORGE_HANDOFF_BODY({ id: 7, pluginSlug: 'hello', sha256: SHA }) }, opts: { nonce: handoffNonce({ id: 7, sha256: SHA }) } });
    expect(FORGE_HANDOFF_BODY({ id: 7, pluginSlug: 'hello', sha256: SHA })).toBe(`Release #7 approved by a Bot Admin: code will build plugin hello from these exact bytes (sha256 ${SHA.slice(0, 16)}) and stage it. It is NOT installed until a Bot Admin runs /mcp approve; do not say it is installed.`);
    expect(r.calls).not.toContain('postFile');
    expect(r.calls.indexOf('enqueue')).toBeLessThan(r.calls.indexOf('post'));
    expect(r.calls.indexOf('post')).toBeLessThan(r.calls.indexOf('settleReleased'));
    expect(r.notices.at(-1)!.text).toMatch(/NOT installed|not installed|stage/i);
    expect(r.notices.at(-1)!.text).not.toMatch(/you may now report it as released/);
  });
  it('an invalid pinned zip: repo.fail(plugin_invalid), the card note and the head notice, never a revert and no notice post', async () => {
    const r = rig({ enqueue: async () => ({ ok: false, code: 'plugin_invalid' }) });
    expect(await r.click()).toEqual({ ok: false, code: 'plugin_invalid', text: DECIDE_TEXT.plugin_invalid });
    expect(DECIDE_TEXT.plugin_invalid).toBe('The stored plugin no longer passes the plugin rules; nothing was built and the request was closed.');
    expect(r.repo.fail).toHaveBeenCalledWith(7, 'plugin_invalid');
    expect(r.calls).not.toContain('revert');
    expect(r.calls).not.toContain('post');
    expect(r.calls).not.toContain('settleReleased');
    expect(r.closed).toHaveLength(1);
    expect(r.notices).toHaveLength(1);
    expect(r.audits.at(-1)).toMatchObject({ action: 'release.decide', outcome: '#7 failed:plugin_invalid' });
  });
  it('an enqueue exception reverts the row to pending (certain: nothing happened)', async () => {
    const r = rig({ enqueue: async () => { throw new Error('db down'); } });
    expect(await r.click()).toEqual({ ok: false, code: 'post_failed', text: DECIDE_TEXT.post_failed });
    expect(r.calls).toContain('revert');
    expect(r.calls).not.toContain('post');
    const r2 = rig({ enqueue: async () => ({ ok: false, code: 'exception' }) });
    expect(await r2.click()).toMatchObject({ ok: false, code: 'post_failed' });
    expect(r2.calls).toContain('revert');
  });
  it('a certain post refusal reverts (the inert build row stays; a second admin may approve)', async () => {
    const err = Object.assign(new Error('Missing Access'), { name: 'DiscordAPIError', status: 403 });
    const r = rig({ post: async () => { throw err; } });
    expect(await r.click()).toMatchObject({ ok: false, code: 'post_failed' });
    expect(r.calls).toContain('revert');
    expect(r.calls).not.toContain('settleReleased');
  });
  it('an unknown post result fails the row post_unknown and settles nothing (reconcile cancels the build)', async () => {
    const r = rig({ post: async () => { throw new Error('timeout'); } });
    expect(await r.click()).toMatchObject({ ok: false, code: 'post_unknown' });
    expect(r.repo.fail).toHaveBeenCalledWith(7, 'post_unknown');
    expect(r.calls).not.toContain('revert');
    expect(r.calls).not.toContain('settleReleased');
  });
  it('the hash check still runs first: a stored zip that does not match the sha256 fails hash_mismatch before any enqueue', async () => {
    const r = rig({ repo: { claim: vi.fn(async () => ({ ...rowOf({ status: 'releasing', decidedBy: ADMIN }), zip: Buffer.from('tampered') })) } });
    expect(await r.click()).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(r.calls).not.toContain('enqueue');
  });
  it('FG-AC12: nothing in the service or its target can activate a server (no activate, no approve, no stage)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['releases/service.ts', 'releases/targets.ts']) {
      const t = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(t, f).not.toMatch(/\bactivate\b|\bstageRelease\b|mcp\/admin|db\/repos\/mcp/);
    }
  });
});
