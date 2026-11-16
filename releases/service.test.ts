import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildPlainMessage } from '../discord/embeds/index.js';
import { SandboxError } from '../tools/plugins/workspace/sandbox.js';
import { WS_TEXT, WsError } from '../workspaces/errors.js';
import { DECIDE_TEXT, REASON_SCREEN, REQUEST_TEXT, ReleaseService, SETTLE_UNSETTLED_TEXT, type ReleaseDeps, type RunInfo } from './service.js';
import { handoffBody } from './targets.js';

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
const MARKER = 'PLANTED-MARKER-77';
const ZIP = Buffer.from('PK-fake-zip-bytes');
const SHA = createHash('sha256').update(ZIP).digest('hex');
const EXPIRES = new Date('2026-12-01T00:00:00Z');

const clean = (over: Partial<RunInfo> = {}): RunInfo => ({ tainted: false, task: { id: TASK, rootId: ROOT, tainted: false }, ownsTask: true, source: { channelId: SRC, threadId: THREAD }, ...over });
const INPUT = { slug: 'my-app', title: 'My app v1', summary: 'A small app. It has tests.' };

const rowOf = (over: Record<string, unknown> = {}) => ({
  id: 7, token: TOKEN, deptId: 'software', requester: 'head:software', taskId: TASK, rootId: ROOT, projectId: null, target: 'handoff', title: 'My app v1', summary: 'A small app. It has tests.', slug: 'my-app',
  sha256: SHA, bytes: ZIP.length, files: 3, skipped: 0, evidence: { runs: [], writesAfterLastRun: null }, tainted: false, catalogDigest: 'd'.repeat(64), sourceChannelId: SRC, sourceThreadId: THREAD,
  status: 'pending', channelId: CONFIG, messageId: CARD_MSG, createdAt: new Date(), expiresAt: EXPIRES, decidedBy: null, decidedAt: null, reason: null, releasedMessageId: null, releasedAt: null, outcome: null, live: true, ...over,
});

function rig(over: { enabled?: () => unknown; wsEnabled?: () => unknown; halted?: boolean; failCard?: boolean; failCopy?: boolean; repo?: Record<string, unknown>; ws?: Record<string, unknown>; byRoot?: unknown; secrets?: string[] } = {}) {
  const calls: string[] = [];
  const audits: { actor: string; action: string; tool?: string | null; outcome?: string | null }[] = [];
  const cards: Record<string, unknown>[] = [];
  const files: { actor: unknown; target: unknown; payload: Record<string, unknown>; file: { name: string; data: Buffer; contentType: string; nonce?: string } }[] = [];
  const prov: unknown[][] = [];
  const closed: { channelId: string; messageId: string; note: string }[] = [];
  const notices: { dept: string; text: string }[] = [];
  const logs: unknown[] = [];
  const st = { halted: over.halted ?? false };
  const secrets = over.secrets ?? [];
  const track = <T>(name: string, f: (...a: never[]) => T) => vi.fn((...a: never[]) => { calls.push(name); return f(...a); });
  const repo = {
    openCounts: track('openCounts', async () => ({ tree: 0, dept: 0, total: 0, today: 0 })),
    window: track('window', async () => ({ since: '2026-01-01T00:00:00.000000Z', until: '2026-01-02T00:00:00.123456Z' })),
    evidence: track('evidence', async () => ({ runs: [], writesAfterLastRun: null })),
    create: track('create', async () => ({ ok: true as const, id: 7, expiresAt: EXPIRES })),
    setCard: track('setCard', async () => true),
    byToken: track('byToken', async () => rowOf()),
    byId: track('byId', async () => rowOf()),
    claim: track('claim', async () => ({ ...rowOf({ status: 'releasing', decidedBy: ADMIN }), zip: ZIP })),
    revert: track('revert', async () => true),
    settleReleased: track('settleReleased', async () => true),
    fail: track('fail', async () => true),
    reject: track('reject', async () => rowOf({ status: 'rejected', decidedBy: ADMIN })),
    rejectById: track('rejectById', async () => rowOf({ status: 'rejected', decidedBy: ADMIN })),
    expire: track('expire', async () => [] as unknown[]),
    failInterrupted: track('failInterrupted', async () => [] as unknown[]),
    list: track('list', async () => [] as unknown[]),
    now: track('now', async () => '2026-01-02T00:00:00.000000Z'),
    ...over.repo,
  };
  const ws = { export: track('export', async () => ({ zip: ZIP, files: 3, sha256: SHA, skipped: 0 })), ...over.ws };
  const deps = {
    repo, ws, projects: { byRoot: track('byRoot', async () => over.byRoot ?? null) },
    enabled: over.enabled ?? (() => true), wsEnabled: over.wsEnabled ?? (() => true), halted: () => st.halted, tz: () => 'Asia/Bangkok',
    audit: async (e: never) => void audits.push(e), secrets, configChannelId: CONFIG, catalogDigest: 'd'.repeat(64),
    postCard: track('postCard', async (p: Record<string, unknown>) => { if (over.failCard) throw new Error('boom'); cards.push(p); return CARD_MSG; }),
    postFile: track('postFile', async (actor: unknown, target: unknown, payload: Record<string, unknown>, file: { name: string; data: Buffer; contentType: string; nonce?: string }) => {
      files.push({ actor, target, payload, file });
      if (target && (target as { channelId: string }).channelId === CONFIG) { if (over.failCopy) throw new Error('boom'); return COPY_MSG; }
      return POSTED;
    }),
    provenance: { record: track('record', async (...a: unknown[]) => void prov.push(a)) },
    closeCard: async (channelId: string, messageId: string, note: string) => void closed.push({ channelId, messageId, note }),
    notifyHead: async (dept: string, text: string) => void notices.push({ dept, text }),
    log: { error: (o: unknown) => void logs.push(o) },
    newToken: () => TOKEN,
  } as unknown as ReleaseDeps;
  const svc = new ReleaseService(deps);
  const click = (action: 'approve' | 'reject', o: Partial<{ token: string; userId: string; channelId: string | null; messageId: string | null }> = {}) =>
    svc.decide({ token: o.token ?? TOKEN, action, userId: o.userId ?? ADMIN, channelId: o.channelId === undefined ? CONFIG : o.channelId, messageId: o.messageId === undefined ? CARD_MSG : o.messageId });
  return { svc, repo, ws, deps, st, calls, audits, cards, files, prov, closed, notices, logs, click, secrets };
}
const SIDE = ['openCounts', 'export', 'window', 'evidence', 'create', 'setCard', 'postFile', 'postCard'];

describe('request: the refusal order (spec 3.2 steps 1-8), every refusal audited, no side effect before the export', () => {
  const cases: [string, Partial<Parameters<typeof rig>[0]>, RunInfo | null, Parameters<ReleaseService['request']>[0], keyof typeof REQUEST_TEXT][] = [
    ['not_software (persona)', { halted: true }, null, { kind: 'persona', personaId: 'p1' }, 'not_software'],
    ['not_software (other head)', { halted: true }, null, { kind: 'head', dept: 'rnd' }, 'not_software'],
    ['not_software (Praw through "*")', { halted: true }, null, { kind: 'head', dept: 'praw' }, 'not_software'],
    ['halted', { halted: true, enabled: () => false }, null, HEAD, 'halted'],
    ['off (false)', { enabled: () => false, wsEnabled: () => false }, clean({ task: null }), HEAD, 'off'],
    ['off (a read error)', { enabled: () => { throw new Error('x'); } }, clean({ task: null }), HEAD, 'off'],
    ['off (not exactly true)', { enabled: () => 'true' }, clean({ task: null }), HEAD, 'off'],
    ['no_task (none)', {}, clean({ task: null, source: null }), HEAD, 'no_task'],
    ['no_task (not the owner)', {}, clean({ ownsTask: false, source: null }), HEAD, 'no_task'],
    ['no_source (missing)', { wsEnabled: () => false }, clean({ source: null }), HEAD, 'no_source'],
    ['no_source (empty channel)', {}, clean({ source: { channelId: '', threadId: null } }), HEAD, 'no_source'],
    ['no_source (not a snowflake)', {}, clean({ source: { channelId: 'chan', threadId: null } }), HEAD, 'no_source'],
    ['no_source (thread not a snowflake)', {}, clean({ source: { channelId: SRC, threadId: 'th' } }), HEAD, 'no_source'],
    ['ws_off (false)', {}, clean(), HEAD, 'ws_off'],
    ['ws_off (a read error)', { wsEnabled: () => { throw new Error('x'); } }, clean(), HEAD, 'ws_off'],
  ];
  for (const [name, o, run, actor, code] of cases) {
    it(name, async () => {
      const wsDefault = name.startsWith('ws_off') ? {} : { wsEnabled: () => true };
      const r = rig({ ...wsDefault, ...o, ...(name === 'ws_off (false)' ? { wsEnabled: () => false } : {}) });
      const res = await r.svc.request(actor, run ?? clean(), INPUT);
      expect(res).toEqual({ ok: false, code, error: REQUEST_TEXT[code] });
      for (const s of SIDE) expect(r.calls, s).not.toContain(s);
      expect(r.audits).toEqual([expect.objectContaining({ action: 'release.request', tool: 'release_request', outcome: `refused:${code}` })]);
    });
  }

  it('the screen refusal (a literal secret, a control character) is refused before any export, and the stored text is the screened text', async () => {
    const r = rig({ secrets: ['SUPERSECRETVALUE123'] });
    for (const bad of [{ title: 'has SUPERSECRETVALUE123 inside' }, { summary: 'x​y' }, { title: 'ok', summary: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }]) {
      expect(await r.svc.request(HEAD, clean(), { ...INPUT, ...bad })).toEqual({ ok: false, code: 'screen', error: REQUEST_TEXT.screen });
    }
    for (const s of SIDE) expect(r.calls).not.toContain(s);
    const ok = rig();
    await ok.svc.request(HEAD, clean(), { slug: 'my-app', title: '  Mail   bob@example.com  ', summary: 'line one\n\nline two' });
    const made = (ok.repo.create.mock.calls[0] as unknown[])[0] as { title: string; summary: string };
    expect(made.title).toBe('Mail bob@example.com'.replace('bob@example.com', '[email]'));
    expect(made.summary).toBe('line one line two');
  });

  it('the cap pre-check reports the repo counts and skips the export', async () => {
    for (const [counts, code] of [[{ tree: 1, dept: 0, total: 0, today: 0 }, 'tree_pending'], [{ tree: 0, dept: 2, total: 0, today: 0 }, 'dept_cap'], [{ tree: 0, dept: 0, total: 5, today: 0 }, 'total_cap'], [{ tree: 0, dept: 0, total: 0, today: 5 }, 'day_cap']] as const) {
      const r = rig({ repo: { openCounts: vi.fn(async () => counts) } });
      expect(await r.svc.request(HEAD, clean(), INPUT)).toEqual({ ok: false, code, error: REQUEST_TEXT[code] });
      expect(r.calls).not.toContain('export');
    }
  });

  it('a tainted run and a tainted task are allowed and flagged', async () => {
    const a = rig();
    expect((await a.svc.request(HEAD, clean({ tainted: true }), INPUT)).ok).toBe(true);
    expect((a.repo.create.mock.calls[0] as unknown[])[0]).toMatchObject({ tainted: true });
    const b = rig();
    await b.svc.request(HEAD, clean({ task: { id: TASK, rootId: ROOT, tainted: true } }), INPUT);
    expect((b.repo.create.mock.calls[0] as unknown[])[0]).toMatchObject({ tainted: true });
    expect(String((b.cards[0] as { body: string }).body)).toContain('The requesting run read outside content (tainted). Review the files before approving.');
  });
});

describe('request: the export (step 9) and the pinned bytes', () => {
  it('maps WsError and SandboxError to their own fixed text, anything else to exception (log errName only)', async () => {
    for (const [err, text] of [[new WsError('E_BUSY'), WS_TEXT.E_BUSY], [new WsError('E_SLUG'), WS_TEXT.E_SLUG], [new WsError('E_EXPORT_SIZE'), WS_TEXT.E_EXPORT_SIZE], [new WsError('E_EXPORT_SECRET', 2), WS_TEXT.E_EXPORT_SECRET.replace('<n>', '2')], [new WsError('E_IO'), WS_TEXT.E_IO], [new SandboxError('Path escapes the workspace.'), 'Path escapes the workspace.']] as const) {
      const r = rig({ ws: { export: vi.fn(async () => { throw err; }) } });
      expect(await r.svc.request(HEAD, clean(), INPUT)).toMatchObject({ ok: false, error: text });
      expect(r.calls).not.toContain('create');
    }
    const r = rig({ ws: { export: vi.fn(async () => { throw new TypeError(MARKER); }) } });
    expect(await r.svc.request(HEAD, clean(), INPUT)).toEqual({ ok: false, code: 'exception', error: REQUEST_TEXT.exception });
    expect(r.logs).toEqual([{ errName: 'TypeError' }]);
    expect(JSON.stringify([r.logs, r.audits])).not.toContain(MARKER);
  });

  it('a zip over 10,000,000 bytes is the export-size text', async () => {
    const big = Buffer.alloc(10_000_001);
    const r = rig({ ws: { export: vi.fn(async () => ({ zip: big, files: 1, sha256: 'a'.repeat(64), skipped: 0 })) } });
    expect(await r.svc.request(HEAD, clean(), INPUT)).toMatchObject({ ok: false, error: WS_TEXT.E_EXPORT_SIZE });
    expect(r.calls).not.toContain('create');
  });

  it('the literal secrets are read at the call (the array grows at boot)', async () => {
    const r = rig();
    r.secrets.push('LATE-SECRET-VALUE-9');
    await r.svc.request(HEAD, clean(), INPUT);
    expect((r.ws.export.mock.calls[0] as unknown[])[1]).toEqual(['LATE-SECRET-VALUE-9']);
  });

  it('RL-C4: the evidence window is read right after the export; evidence gets (slug, since, until); a missing workspace row is an exception', async () => {
    const r = rig();
    await r.svc.request(HEAD, clean(), INPUT);
    expect(r.calls.indexOf('window')).toBe(r.calls.indexOf('export') + 1);
    expect(r.repo.evidence).toHaveBeenCalledWith('my-app', '2026-01-01T00:00:00.000000Z', '2026-01-02T00:00:00.123456Z');
    const none = rig({ repo: { window: vi.fn(async () => ({ since: null, until: '2026-01-02T00:00:00.000000Z' })) } });
    expect(await none.svc.request(HEAD, clean(), INPUT)).toEqual({ ok: false, code: 'exception', error: REQUEST_TEXT.exception });
    expect(none.calls).not.toContain('create');
  });

  it('create gets the pinned bytes, the code-chosen token, the DB-side fields and the project of the task tree', async () => {
    const r = rig({ byRoot: { id: 4, title: 'Proj', status: 'active' } });
    await r.svc.request(HEAD, clean(), INPUT);
    expect(r.repo.create).toHaveBeenCalledTimes(1);
    const [made, tz] = r.repo.create.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(tz).toBe('Asia/Bangkok');
    expect(made).toMatchObject({ token: TOKEN, deptId: 'software', requester: 'head:software', taskId: TASK, rootId: ROOT, projectId: 4, target: 'handoff', slug: 'my-app', sha256: SHA, bytes: ZIP.length, files: 3, skipped: 0, tainted: false, catalogDigest: 'd'.repeat(64), sourceChannelId: SRC, sourceThreadId: THREAD });
    expect(made.zip).toBe(ZIP);
    expect(made).not.toHaveProperty('expiresAt'); // RL-C11: the expiry is computed in SQL
  });

  it('a create refusal (caps under the lock, one per tree) maps to its text with no card', async () => {
    const r = rig({ repo: { create: vi.fn(async () => ({ ok: false, code: 'tree_pending' })) } });
    expect(await r.svc.request(HEAD, clean(), INPUT)).toEqual({ ok: false, code: 'tree_pending', error: REQUEST_TEXT.tree_pending });
    expect(r.calls).not.toContain('postFile');
    expect(r.calls).not.toContain('postCard');
  });
});

describe('request: the card and the success text (spec 3.2 steps 12-14, 3.5, RL-C8, RL-C10, RL-C12)', () => {
  const unix = Math.floor(EXPIRES.getTime() / 1000);
  it('audits `#<id> <slug> <sha16>`, posts the copy then the card, stores the card, answers with the fixed text', async () => {
    const r = rig();
    const res = await r.svc.request(HEAD, clean(), INPUT);
    expect(res).toEqual({ ok: true, id: 7, text: `Release request #7 for my-app was sent to the Bot Admins (3 file(s), ${ZIP.length} bytes, sha256 ${SHA.slice(0, 16)}). NOTHING is released yet; you will be told in your room. Do not say it is released, and do not push or publish it with other tools.` });
    expect(r.audits).toEqual([{ actor: 'head:software', action: 'release.request', tool: 'release_request', taskId: TASK, outcome: `#7 my-app ${SHA.slice(0, 16)}` }]);
    expect(r.audits[0]!.outcome).toMatch(/^#\d+ [a-z][a-z0-9-]{1,39} [0-9a-f]{16}$/);
    expect(r.calls.indexOf('postFile')).toBeLessThan(r.calls.indexOf('postCard'));
    expect(r.repo.setCard).toHaveBeenCalledWith(7, CONFIG, CARD_MSG);
  });

  it('the artefact copy: posted as hq in #setting from the pinned Buffer as application/zip, recorded tainted (RL-C9)', async () => {
    const r = rig();
    await r.svc.request(HEAD, clean(), INPUT);
    const f = r.files[0]!;
    expect(f.actor).toEqual({ kind: 'head', dept: 'hq' });
    expect(f.target).toEqual({ channelId: CONFIG });
    expect(f.file).toEqual({ name: 'my-app-release-7.zip', data: ZIP, contentType: 'application/zip' });
    expect(f.payload).toMatchObject({ type: 'chat', body: `Release #7 artefact for review: my-app, 3 file(s), ${ZIP.length} bytes, sha256 ${SHA}. Written by bots and container code; open with care. Do not run or install it on your own machine; open it in a sandbox.` });
    expect(r.prov[0]).toEqual([COPY_MSG, CONFIG, true, null]);
  });

  it('the exact card: lines in order, the project line, the not-tracked sentence, the sandbox sentence, the two fields', async () => {
    const r = rig({ byRoot: { id: 4, title: 'Big *Project*', status: 'active' } });
    await r.svc.request(HEAD, clean(), INPUT);
    expect(r.cards[0]).toEqual({
      type: 'approval', origin: 'governance', title: 'Release request', releaseCardId: TOKEN,
      body: [
        '**My app v1**',
        'Release #7 from the software head. Target: handoff (post the zip in the task thread and mark it released).',
        'Project of the requesting task: Project #4 Big \\*Project\\* (active). The workspace is not linked to a project.',
        `Artefact: workspace my-app, 3 file(s), ${ZIP.length} bytes, sha256 ${SHA}.`,
        'Pinned: these exact bytes are stored; Approve releases them even if the workspace changes later.',
        'The files were written by bots and container code.',
        'Whether earlier runs that wrote these files read outside content is not tracked.',
        'Do not run or install it on your own machine; open it in a sandbox.',
        'Artefact copy: posted just above this card.',
        `Tool catalog ${'d'.repeat(16)}.`,
        `Expires <t:${unix}:R>.`,
      ].join('\n'),
      fields: [
        { name: 'Summary (written by the bot, untrusted)', value: 'A small app. It has tests.' },
        { name: "Evidence (recorded by code; each verb runs the workspace's own bot-written scripts)", value: 'No test run recorded for this workspace.' },
      ],
    });
  });

  it('no project: the task tree id; skipped entries are counted; a copy that failed says so', async () => {
    const r = rig({ failCopy: true, ws: { export: vi.fn(async () => ({ zip: ZIP, files: 3, sha256: SHA, skipped: 2 })) } });
    await r.svc.request(HEAD, clean(), INPUT);
    const body = (r.cards[0] as { body: string }).body;
    expect(body).toContain('Project of the requesting task: none (task tree abcdef01). The workspace is not linked to a project.');
    expect(body).toContain(`sha256 ${SHA}. 2 entries skipped (not exportable).`);
    expect(body).toContain('Artefact copy: could not be posted here.');
  });

  it('evidence lines: the runs, the changed-after sentence and the can-itself-change sentence', async () => {
    const at = '2026-01-01T10:00:00.000Z';
    const u = Math.floor(Date.parse(at) / 1000);
    const r = rig({ repo: { evidence: vi.fn(async () => ({ runs: [{ verb: 'test', result: 'exit=1', at }, { verb: 'install', result: 'timeout', at }], writesAfterLastRun: true })) } });
    await r.svc.request(HEAD, clean(), INPUT);
    const f = (r.cards[0] as { fields: { name: string; value: string }[] }).fields[1]!;
    expect(f.value).toBe([`- ws_run test: exit 1 (<t:${u}:f>)`, `- ws_run install: timeout (<t:${u}:f>)`, 'ws_write/ws_delete after the last run: yes. A ws_run can itself change files.'].join('\n'));
    const q = rig({ repo: { evidence: vi.fn(async () => ({ runs: [{ verb: 'test', result: 'exit=0', at }], writesAfterLastRun: false })) } });
    await q.svc.request(HEAD, clean(), INPUT);
    expect((q.cards[0] as { fields: { value: string }[] }).fields[1]!.value).toContain('ws_write/ws_delete after the last run: no. A ws_run can itself change files.');
  });

  it('RL-C10: title and summary are escaped on the card (no live mention, no markdown link)', async () => {
    const r = rig();
    await r.svc.request(HEAD, clean(), { slug: 'my-app', title: '@everyone <@123456789012345678> [x](http://e.test)', summary: '@here [click](http://e.test) `code`' });
    const c = r.cards[0] as { body: string; fields: { value: string }[] };
    for (const s of [c.body, c.fields[0]!.value]) {
      expect(s).not.toMatch(/@(everyone|here)/);
      expect(s).not.toMatch(/(?<!\\)<@/);
      expect(s).not.toMatch(/(?<!\\)\[[^\]]*\]\(/);
    }
  });

  it('a card that cannot be posted leaves the row pending without a card and appends the fixed sentence; nothing throws', async () => {
    const r = rig({ failCard: true });
    const res = await r.svc.request(HEAD, clean(), INPUT);
    expect(res).toMatchObject({ ok: true, id: 7 });
    expect((res as { text: string }).text.endsWith(' The card could not be posted; a Bot Admin can see it in /release list.')).toBe(true);
    expect(r.repo.setCard).not.toHaveBeenCalled();
    expect(r.logs).toEqual([{ errName: 'Error' }]);
  });

  it('a repo or audit fault after the refusals is the exception text and logs errName only', async () => {
    const r = rig({ repo: { openCounts: vi.fn(async () => { throw new RangeError(MARKER); }) } });
    expect(await r.svc.request(HEAD, clean(), INPUT)).toEqual({ ok: false, code: 'exception', error: REQUEST_TEXT.exception });
    expect(r.logs).toEqual([{ errName: 'RangeError' }]);
    expect(JSON.stringify([r.logs, r.audits])).not.toContain(MARKER);
  });

  it('the maximum card (full-length title, summary and project title of escape characters) builds from the fixed texts without a throw', async () => {
    const r = rig({ byRoot: { id: 99999, title: '*'.repeat(60), status: 'active' } });
    const res = await r.svc.request(HEAD, clean(), { slug: 'a'.repeat(40).replace(/^a/, 'b'), title: '*'.repeat(100), summary: '*'.repeat(600) });
    expect(res.ok).toBe(true);
    expect((r.cards[0] as { body: string }).body.length).toBeLessThan(4096);
  });
});

describe('RL-C3: the handoff body is exactly one message', () => {
  const ctx = { deptColor: 1, adminRoleId: 'a', dept: 'software' } as never;
  it('the worst case (escape-doubling title and summary, max slug, id, files, bytes, sha) is one plain message', () => {
    const body = handoffBody({ id: 9_999_999_999, slug: 'b'.repeat(40), title: '*'.repeat(100), summary: '*'.repeat(600), files: 2000, bytes: 10_000_000, sha256: 'f'.repeat(64) }, []);
    expect(body.length).toBeLessThan(1900);
    expect(buildPlainMessage({ type: 'chat', body, noHandles: true }, ctx)).toHaveLength(1);
    expect(buildPlainMessage({ type: 'chat', body: body.replace(/\*/g, '@'), noHandles: true }, ctx)).toHaveLength(1);
  });
  it('the exact text (RL-C8c, RL-C10): the summary label and the sandbox sentence', () => {
    expect(handoffBody({ id: 7, slug: 'my-app', title: 'My app v1', summary: 'A small app.', files: 3, bytes: 17, sha256: SHA }, [])).toBe(
      `Release #7 approved by a Bot Admin - My app v1: my-app, 3 file(s), 17 bytes, sha256 ${SHA}.\nSummary (written by the bot): A small app.\nDo not run or install it on your own machine; open it in a sandbox.`);
  });
  it('title and summary are escaped with the secrets list', () => {
    const b = handoffBody({ id: 7, slug: 'my-app', title: '@everyone [a](http://e.test)', summary: 'x LITSECRET-12345 y', files: 1, bytes: 1, sha256: SHA }, ['LITSECRET-12345']);
    expect(b).not.toMatch(/@everyone/);
    expect(b).not.toContain('LITSECRET-12345');
    expect(b).not.toMatch(/(?<!\\)\[a\]\(/);
  });
});

describe('decide: approve (spec 3.3, RL-C3, RL-C11)', () => {
  it('the happy path: claim, re-hash, post as the head from the pinned bytes, provenance tainted, settle, audit, close the card, notify the head', async () => {
    const r = rig();
    const res = await r.click('approve');
    expect(res).toMatchObject({ ok: true, result: 'released' });
    expect(r.repo.claim).toHaveBeenCalledWith(TOKEN, ADMIN);
    const f = r.files[0]!;
    expect(f.actor).toEqual({ kind: 'head', dept: 'software' });
    expect(f.target).toEqual({ channelId: SRC, threadId: THREAD });
    expect(f.payload).toMatchObject({ type: 'chat', noHandles: true });
    expect(f.file).toEqual({ name: 'my-app.zip', data: ZIP, contentType: 'application/zip', nonce: `rel-7-${SHA.slice(0, 8)}` });
    expect(r.prov[0]).toEqual([POSTED, THREAD, true, null]);
    expect(r.repo.settleReleased).toHaveBeenCalledWith(7, POSTED);
    expect(r.calls.indexOf('claim')).toBeLessThan(r.calls.indexOf('postFile'));
    expect(r.calls.indexOf('postFile')).toBeLessThan(r.calls.indexOf('settleReleased'));
    expect(r.audits).toEqual([expect.objectContaining({ actor: `user:${ADMIN}`, action: 'release.decide', tool: 'release_request', outcome: `#7 released ${SHA.slice(0, 16)}` })]);
    expect(r.closed).toEqual([{ channelId: CONFIG, messageId: CARD_MSG, note: `Released by <@${ADMIN}>. Posted in the task thread (sha256 ${SHA.slice(0, 16)}). Root task abcdef01: when its work is finished it can be accepted with /task done.` }]);
    expect(r.notices).toEqual([{ dept: 'software', text: 'Release #7 (my-app) was approved by a Bot Admin and posted in the task thread. You may now report it as released; if this finishes the task, mark it done.' }]);
  });

  it('a project release offers /project close in the card note; a channel-only source has no threadId in the target', async () => {
    const r = rig({ repo: { byToken: vi.fn(async () => rowOf({ projectId: 4, sourceThreadId: null })), claim: vi.fn(async () => ({ ...rowOf({ projectId: 4, sourceThreadId: null, status: 'releasing' }), zip: ZIP })) } });
    await r.click('approve');
    expect(r.closed[0]!.note.endsWith(' Project #4: if its work is finished, close it with /project close id:4.')).toBe(true);
    expect(r.files[0]!.target).toEqual({ channelId: SRC });
    expect(r.prov[0]![1]).toBe(SRC);
  });

  it('wrong_card: a bad token, an unknown token, another channel, another message, no stored card, a click outside #setting', async () => {
    const r = rig();
    for (const c of [{ token: 'xyz' }, { channelId: SRC }, { messageId: '800000000000000099' }, { channelId: null }, { messageId: null }]) {
      expect(await r.click('approve', c)).toEqual({ ok: false, code: 'wrong_card', text: DECIDE_TEXT.wrong_card });
    }
    const unknown = rig({ repo: { byToken: vi.fn(async () => null) } });
    expect(await unknown.click('approve')).toMatchObject({ ok: false, code: 'wrong_card' });
    const nocard = rig({ repo: { byToken: vi.fn(async () => rowOf({ messageId: null, channelId: null })) } });
    expect(await nocard.click('approve')).toMatchObject({ ok: false, code: 'wrong_card' });
    const elsewhere = rig({ repo: { byToken: vi.fn(async () => rowOf({ channelId: SRC })) } });
    expect(await elsewhere.click('approve', { channelId: SRC })).toMatchObject({ ok: false, code: 'wrong_card' });
    for (const x of [r, unknown, nocard, elsewhere]) { expect(x.calls).not.toContain('claim'); expect(x.calls).not.toContain('postFile'); }
  });

  it('not_pending, expired, halted (row stays pending), off and a read error (row stays pending); claim is never called', async () => {
    const np = rig({ repo: { byToken: vi.fn(async () => rowOf({ status: 'released' })) } });
    expect(await np.click('approve')).toEqual({ ok: false, code: 'not_pending', text: DECIDE_TEXT.not_pending });
    const ex = rig({ repo: { byToken: vi.fn(async () => rowOf({ live: false })) } });
    expect(await ex.click('approve')).toEqual({ ok: false, code: 'expired', text: DECIDE_TEXT.expired });
    const h = rig({ halted: true });
    expect(await h.click('approve')).toEqual({ ok: false, code: 'halted', text: DECIDE_TEXT.halted });
    const off = rig({ enabled: () => false });
    expect(await off.click('approve')).toEqual({ ok: false, code: 'off', text: DECIDE_TEXT.off });
    const err = rig({ enabled: () => { throw new Error('x'); } });
    expect(await err.click('approve')).toMatchObject({ ok: false, code: 'off' });
    for (const x of [np, ex, h, off, err]) { expect(x.calls).not.toContain('claim'); expect(x.calls).not.toContain('revert'); expect(x.calls).not.toContain('fail'); }
  });

  it('a lost claim is not_pending and posts nothing', async () => {
    const r = rig({ repo: { claim: vi.fn(async () => null) } });
    expect(await r.click('approve')).toEqual({ ok: false, code: 'not_pending', text: DECIDE_TEXT.not_pending });
    expect(r.calls).not.toContain('postFile');
  });

  it('hash_mismatch: the row fails with the zip purged, nothing is posted, the card, the head and the audit say so', async () => {
    const r = rig({ repo: { claim: vi.fn(async () => ({ ...rowOf({ status: 'releasing' }), zip: Buffer.from('PK-other-bytes!!') })) } });
    expect(await r.click('approve')).toEqual({ ok: false, code: 'hash_mismatch', text: DECIDE_TEXT.hash_mismatch });
    expect(r.repo.fail).toHaveBeenCalledWith(7, 'hash_mismatch');
    expect(r.calls).not.toContain('postFile');
    expect(r.closed[0]!.note).toBe('Closed: the stored artefact did not match its sha256. Nothing was released.');
    expect(r.notices[0]!.text).toBe('Release #7 (my-app) was closed: the stored artefact did not match its sha256. Nothing was released.');
    expect(r.audits).toEqual([expect.objectContaining({ action: 'release.decide', outcome: '#7 failed:hash_mismatch' })]);
    const wrongLen = rig({ repo: { claim: vi.fn(async () => ({ ...rowOf({ status: 'releasing', bytes: ZIP.length + 1 }), zip: ZIP })) } });
    expect(await wrongLen.click('approve')).toMatchObject({ code: 'hash_mismatch' });
  });

  it('G2-RL-08: the handoff carries a Discord nonce (at most 25 characters, from the row, no token) that is the same on a second attempt for the same release', async () => {
    const first = rig();
    await first.click('approve');
    const n1 = first.files[0]!.file.nonce!;
    expect(n1).toMatch(/^[A-Za-z0-9-]{1,25}$/);
    expect(n1).not.toContain(TOKEN.slice(0, 8));
    const again = rig();
    await again.click('approve');
    expect(again.files[0]!.file.nonce).toBe(n1);
    const other = rig({ repo: { claim: vi.fn(async () => ({ ...rowOf({ id: 8, status: 'releasing' }), zip: ZIP })) } });
    await other.click('approve');
    expect(other.files[0]!.file.nonce).not.toBe(n1);
  });

  describe('RL-C3: revert only on a certain refusal', () => {
    const certain: [string, unknown][] = [
      ['a denied channel', Object.assign(new Error('channel is denied'), { name: 'DeniedChannelError' })],
      ['a 403 Missing Permissions', Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 })],
      ['a 404 Unknown Channel', Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 })],
      ['a 400', Object.assign(new Error('bad'), { status: 400 })],
    ];
    for (const [name, err] of certain) {
      it(`${name} reverts to pending and answers post_failed`, async () => {
        const r = rig();
        r.deps.postFile = vi.fn(async () => { throw err; }) as never;
        expect(await r.click('approve')).toEqual({ ok: false, code: 'post_failed', text: DECIDE_TEXT.post_failed });
        expect(r.repo.revert).toHaveBeenCalledWith(7);
        expect(r.repo.fail).not.toHaveBeenCalled();
        expect(r.repo.settleReleased).not.toHaveBeenCalled();
        expect(r.prov).toHaveLength(0);
        expect(r.closed).toHaveLength(0);
      });
    }
    const unknown: [string, unknown][] = [
      ['a plain Error (resolve() failures are plain errors: fail closed)', new Error('boom')],
      ['a 500', Object.assign(new Error('x'), { status: 500 })],
      ['a 503', Object.assign(new Error('x'), { status: 503 })],
      ['a 408', Object.assign(new Error('x'), { status: 408 })],
      ['a timeout', Object.assign(new Error('x'), { name: 'AbortError' })],
      ['a network error', Object.assign(new Error('x'), { code: 'ECONNRESET' })],
      ['a string', 'boom'],
    ];
    for (const [name, err] of unknown) {
      it(`${name} fails the row as post_unknown, never reverts, never re-posts`, async () => {
        const r = rig();
        r.deps.postFile = vi.fn(async () => { throw err; }) as never;
        expect(await r.click('approve')).toEqual({ ok: false, code: 'post_unknown', text: DECIDE_TEXT.post_unknown });
        expect(r.repo.fail).toHaveBeenCalledWith(7, 'post_unknown');
        expect(r.repo.revert).not.toHaveBeenCalled();
        expect(r.repo.settleReleased).not.toHaveBeenCalled();
        expect(r.closed).toEqual([{ channelId: CONFIG, messageId: CARD_MSG, note: 'Release failed: could not confirm the post; check the task thread. Nothing more will be posted.' }]);
        expect(r.notices[0]).toEqual({ dept: 'software', text: 'Release #7 (my-app): could not confirm the post; check the task thread before asking again. Nothing more will be posted.' });
        expect(r.audits).toEqual([expect.objectContaining({ action: 'release.decide', outcome: '#7 failed:post_unknown' })]);
        expect(r.logs).toEqual(typeof err === 'string' ? [{ errName: 'unknown' }] : [{ errName: (err as Error).name }]);
      });
    }
    it('a throw by the claim, the settle fault or the revert fault never posts twice', async () => {
      const posts = vi.fn(async () => POSTED);
      const r = rig({ repo: { settleReleased: vi.fn(async () => { throw new Error(MARKER); }) } });
      r.deps.postFile = posts as never;
      const res = await r.click('approve');
      expect(res).toEqual({ ok: false, code: 'exception', text: SETTLE_UNSETTLED_TEXT });
      expect(posts).toHaveBeenCalledTimes(1);
      expect(r.repo.revert).not.toHaveBeenCalled();
      expect(r.repo.fail).not.toHaveBeenCalled(); // the row stays releasing: recover(bootTime) handles it
      expect(JSON.stringify(r.logs)).not.toContain(MARKER);
    });
  });
});

describe('decide: reject (spec 3.4, RL-C10)', () => {
  it('by button: the CAS reject without a reason, allowed while halted and while off; the card, notice and audit', async () => {
    const r = rig({ halted: true, enabled: () => false });
    expect(await r.click('reject')).toMatchObject({ ok: true, result: 'rejected' });
    expect(r.repo.reject).toHaveBeenCalledWith(TOKEN, ADMIN, null);
    expect(r.closed[0]!.note).toBe(`Rejected by <@${ADMIN}>. Nothing was released.`);
    expect(r.notices[0]).toEqual({ dept: 'software', text: 'Release #7 (my-app) was rejected by a Bot Admin. Nothing was released.' });
    expect(r.audits).toEqual([expect.objectContaining({ action: 'release.decide', outcome: '#7 rejected' })]);
  });
  it('a lost reject CAS (decided meanwhile, or releasing) is not_pending', async () => {
    const r = rig({ repo: { reject: vi.fn(async () => null) } });
    expect(await r.click('reject')).toEqual({ ok: false, code: 'not_pending', text: DECIDE_TEXT.not_pending });
    expect(r.closed).toHaveLength(0);
  });
  it('by command: the reason is screened (secret, control character, empty) and refused with REASON_SCREEN before any write', async () => {
    const r = rig({ secrets: ['SUPERSECRETVALUE123'] });
    for (const bad of ['has SUPERSECRETVALUE123', 'a‮b', 'two\nlines', '   ']) {
      expect(await r.svc.reject({ id: 7, userId: ADMIN, reason: bad })).toEqual({ ok: false, code: 'screen', text: REASON_SCREEN });
    }
    expect(r.calls).not.toContain('rejectById');
  });
  it('by command: the STORED reason is the screened text; the head notice carries it as a quoted Bot Admin reason (RL-C10 scoped exception)', async () => {
    const r = rig();
    const res = await r.svc.reject({ id: 7, userId: ADMIN, reason: '  Needs  tests, call bob@example.com @everyone [x](http://e.test) <@123456789012345678>  ' });
    expect(res).toMatchObject({ ok: true, result: 'rejected' });
    const stored = (r.repo.rejectById.mock.calls[0] as unknown[])[2] as string;
    expect(stored).toBe('Needs tests, call [email] @everyone [x](http://e.test) <@123456789012345678>');
    expect(r.notices[0]!.text).toBe(`Release #7 (my-app) was rejected by a Bot Admin. Nothing was released. Reason from a Bot Admin: "${stored}"`);
    expect(r.closed[0]!.note).toBe(`Rejected by <@${ADMIN}> with a reason. Nothing was released.`);
    expect(r.audits[0]!.outcome).toBe('#7 rejected');
    expect(JSON.stringify(r.audits)).not.toContain('Needs');
  });
  it('by command: an unknown id is not_found; a lost CAS is not_pending', async () => {
    const a = rig({ repo: { byId: vi.fn(async () => null) } });
    expect(await a.svc.reject({ id: 99, userId: ADMIN, reason: 'no' })).toEqual({ ok: false, code: 'not_found', text: DECIDE_TEXT.not_found });
    const b = rig({ repo: { rejectById: vi.fn(async () => null) } });
    expect(await b.svc.reject({ id: 7, userId: ADMIN, reason: 'no' })).toEqual({ ok: false, code: 'not_pending', text: DECIDE_TEXT.not_pending });
  });
});

describe('sweep and recover (spec 3.6, RL-C5)', () => {
  it('sweep: expired rows get the card note, the head notice and an audit from system:release; never throws', async () => {
    const r = rig({ repo: { expire: vi.fn(async () => [rowOf({ status: 'expired' })]) } });
    expect(await r.svc.sweep()).toBe(1);
    expect(r.closed[0]!.note).toBe('Expired after 7 days without a decision.');
    expect(r.notices[0]!.text).toBe('Release #7 (my-app) expired after 7 days without a decision. Nothing was released.');
    expect(r.audits).toEqual([expect.objectContaining({ actor: 'system:release', action: 'release.expire' })]);
    const bad = rig({ repo: { expire: vi.fn(async () => { throw new TypeError(MARKER); }) } });
    expect(await bad.svc.sweep()).toBe(0);
    expect(bad.logs).toEqual([{ errName: 'TypeError' }]);
  });
  it('recover(bootTime): fails only what the repo returns for that bound, tells the card and the head, never posts', async () => {
    const r = rig({ repo: { failInterrupted: vi.fn(async () => [rowOf({ status: 'failed', outcome: 'interrupted' })]) } });
    await r.svc.recover('2026-01-02T00:00:00.000000Z');
    expect(r.repo.failInterrupted).toHaveBeenCalledWith('2026-01-02T00:00:00.000000Z');
    expect(r.calls).not.toContain('postFile');
    expect(r.closed[0]!.note).toBe('Interrupted during the release (restart). Check the task thread; nothing more will be posted.');
    expect(r.notices[0]!.text).toBe('Release #7 (my-app) was interrupted by a restart; check the task thread before asking again.');
    expect(r.audits).toEqual([expect.objectContaining({ action: 'release.decide', outcome: '#7 failed:interrupted' })]);
  });
  it('recover never throws; bootTime() reads the database clock', async () => {
    const r = rig({ repo: { failInterrupted: vi.fn(async () => { throw new TypeError(MARKER); }) } });
    await expect(r.svc.recover('2026-01-02T00:00:00.000000Z')).resolves.toBeUndefined();
    expect(r.logs).toEqual([{ errName: 'TypeError' }]);
    expect(await r.svc.bootTime()).toBe('2026-01-02T00:00:00.000000Z');
  });
  it('a fault while closing the card or telling the head does not stop the rest', async () => {
    const r = rig({ repo: { expire: vi.fn(async () => [rowOf({ status: 'expired' }), rowOf({ id: 8, status: 'expired' })]) } });
    r.deps.closeCard = vi.fn(async () => { throw new Error('x'); }) as never;
    expect(await r.svc.sweep()).toBe(2);
    expect(r.notices).toHaveLength(2);
  });
});
