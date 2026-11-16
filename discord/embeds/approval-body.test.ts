import { describe, expect, it } from 'vitest';
import type { Approval } from '../../db/repos/ledger.js';
import { createHttpClient } from '../../services/http.js';
import { workspaceFetch, ws } from '../../tests/fakes/clickup-workspace.js';
import { webRig } from '../../tools/plugins/web/test-helpers.js';
import { createClickUpClient, listPathText } from '../../tools/plugins/clickup/client.js';
import { clickupGroup } from '../../tools/plugins/clickup/index.js';
import type { PluginDeps } from '../../tools/plugins/deps.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { buildMessage } from './index.js';
import { batchApprovalPayload, cardShowsWhole, compactItemFits, toolApprovalPayload } from './approval.js';

const mk = (id: number, tool: string, input: Record<string, unknown>): Approval => ({
  id, taskId: 'x'.repeat(64), reason: 'ClickUp workspace write: every change needs approval', estCostUsd: 0, requestedBy: 'head:software', status: 'pending', decidedBy: null,
  createdAt: new Date(), decidedAt: null, toolName: tool, toolInput: input, inputSha256: 'a'.repeat(64), kind: 'tool',
});
const PIN = { in_list_id: '7001', list_path: 'Engineering / Backend / Sprint [abc123]' };

/** The limits of C1b: nothing cut, <= 25 fields, <= 1024 per field value, <= 6000 in all. */
function limits(a: Approval) {
  const p = toolApprovalPayload(a);
  const f = p.fields ?? [];
  const total = (p.title ?? '').length + (p.body ?? '').length + f.reduce((n, x) => n + x.name.length + x.value.length, 0);
  return { cut: f.some((x) => x.name === 'Note'), count: f.length, longest: Math.max(...f.map((x) => x.value.length)), total, fields: f };
}

const ALPHABETS: Record<string, string> = {
  backslash: '\\', quote: '"', newline: '\n', 'zero width space': '​', 'tag characters': '\u{E0041}', at: '@', 'angle bracket': '<', emoji: '😀', thai: 'ก', 'markdown': '*', backtick: '`', control: '\u0001',
};

describe('C1 a 1500-character body is refused before a card exists or rendered whole (cut false, within Discord limits)', () => {
  async function setup() {
    const state = ws();
    const client = createClickUpClient({ http: createHttpClient({ fetch: workspaceFetch(state) }), token: state.token, teamId: '9001' });
    const g = clickupGroup({ clickup: client, clickupUsage: { take: async () => true }, cfg: new FakeConfig(), log: { warn: () => undefined }, clock: Date.now } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('off');
    return webRig(g.tools, { direct: true, origin: 'chat', tainted: () => false });
  }

  for (const [label, ch] of Object.entries(ALPHABETS)) {
    for (const [tool, key, base] of [
      ['clickup_add_comment', 'text', { task_id: 'a1' }], ['clickup_update_task', 'description', { task_id: 'a1' }], ['clickup_create_task', 'description', { list_id: '7001', name: 'n' }],
    ] as const) {
      it(`${label} in ${tool}.${key}`, async () => {
        const { reg, c, approvals } = await setup();
        const body = ch.repeat(1500);
        const r = await reg.run(tool, { ...base, [key]: body }, c);
        if (r.isError) {
          expect(approvals.request, 'a refused call files no card').not.toHaveBeenCalled();
          return;
        }
        expect(approvals.request).toHaveBeenCalledTimes(1);
        const stored = (approvals.request.mock.calls[0] as unknown as [{ tool: { name: string; input: Record<string, unknown> } }])[0].tool;
        const l = limits(mk(1, stored.name, stored.input));
        expect(l.cut, label).toBe(false);
        expect(l.count).toBeLessThanOrEqual(25);
        expect(l.longest).toBeLessThanOrEqual(1024);
        expect(l.total).toBeLessThanOrEqual(6000);
        // and the posted message really is one embed within Discord's own limits
        const payload = toolApprovalPayload(mk(1, stored.name, stored.input));
        const rendered = buildMessage(payload, { deptColor: 0 }).flatMap((m) => m.embeds.flatMap((e) => e.fields ?? []));
        expect(rendered).toEqual(payload.fields!.map((f) => ({ name: f.name, value: f.value }))); // the renderer cut and dropped nothing
      });
    }
  }

  it('a 1501-character body is refused by zod', async () => {
    const { reg, c, approvals } = await setup();
    const r = await reg.run('clickup_add_comment', { task_id: 'a1', text: 'a'.repeat(1501) }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('invalid input');
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('a plain 1500-character body is accepted and shown whole in Body chunks, label Body', async () => {
    const { reg, c, approvals } = await setup();
    expect((await reg.run('clickup_add_comment', { task_id: 'a1', text: 'word '.repeat(300).trim() }, c)).isError).toBeFalsy();
    const stored = (approvals.request.mock.calls[0] as unknown as [{ tool: { name: string; input: Record<string, unknown> } }])[0].tool;
    const l = limits(mk(1, stored.name, stored.input));
    expect(l.cut).toBe(false);
    expect(l.fields.some((f) => f.name === 'Body')).toBe(true);
    expect(l.fields.filter((f) => f.name.startsWith('Body')).map((f) => f.value).join('')).toContain('word word word');
  });
});

describe('C1 cardShowsWhole is the one check the precheck uses', () => {
  it('false when the card would cut or overflow, true for an ordinary call', () => {
    expect(cardShowsWhole(mk(1, 'clickup_add_comment', { task_id: 'a1', text: 'hello', ...PIN }))).toBe(true);
    expect(cardShowsWhole(mk(1, 'clickup_add_comment', { task_id: 'a1', text: '\\'.repeat(1500), ...PIN }))).toBe(false); // 4x expansion: 24+ chunks, over the embed limit
    expect(cardShowsWhole(mk(1, 'clickup_add_comment', { task_id: 'a1', text: 'a', ...PIN, x1: 'v'.repeat(500) }))).toBe(false); // an extra field is cut
  });
});

describe('C1c Body in batches', () => {
  it('a Body of more than one chunk never joins a batch (solo card); a short Body does, on one line', () => {
    const long = mk(1, 'clickup_add_comment', { task_id: 'a1', text: 'w'.repeat(600), ...PIN });
    expect(compactItemFits(long)).toBe(false);
    const short = mk(2, 'clickup_add_comment', { task_id: 'a1', text: 'short', ...PIN });
    expect(compactItemFits(short)).toBe(true);
    const msgs = buildMessage(batchApprovalPayload([short], { id: 5, digest: 'abcdef012345' }), { deptColor: 0 });
    expect(msgs[0]!.embeds[0]!.fields![0]!.value).toContain('**Body:** "short"');
    expect(() => batchApprovalPayload([long], { id: 5, digest: 'abcdef012345' })).toThrow();
  });
});

describe('C1 / list mode: a call without the workspace pin keeps today\'s rendering (description cut with a Note, never Body)', () => {
  it('list-mode description shows as a Changes entry', () => {
    const p = toolApprovalPayload(mk(1, 'clickup_create_task', { name: 'n', description: 'd'.repeat(4000) }));
    const f = p.fields ?? [];
    expect(f.some((x) => x.name === 'Body')).toBe(false);
    expect(f.some((x) => x.name === 'Note')).toBe(true);
    expect(f.find((x) => x.name === 'Changes')?.value).toContain('description');
  });
});

describe('C2 destination and name are shown whole (solo and batch)', () => {
  const l = (n: string) => ({ id: '7001', name: n.repeat(100), spaceId: '501', space: n.repeat(100), folder: n.repeat(100), statuses: [] as string[] });
  it('a 3-level path of 100 characters per segment renders with cut false on the solo card and the batch item', () => {
    const path = listPathText(l('p'));
    const a = mk(1, 'clickup_update_task', { task_id: 'a1', name: 'n'.repeat(110), in_list_id: '7001', list_path: path, in_task: 't'.repeat(100) });
    expect(path.length).toBeLessThanOrEqual(110);
    const s = limits(a);
    expect(s.cut).toBe(false);
    expect(compactItemFits(a)).toBe(true);
    const batch = buildMessage(batchApprovalPayload([a], { id: 5, digest: 'abcdef012345' }), { deptColor: 0 });
    const text = batch[0]!.embeds[0]!.fields![0]!.value;
    expect(text).not.toContain('truncated');
    expect(text).toContain(path.replace(/[\\`*_~|>[\]()#]/g, '\\$&'));
  });
  it('the path shown is the whole list_path (no cut) on the solo card', () => {
    const path = listPathText(l('q'));
    const p = toolApprovalPayload(mk(1, 'clickup_add_comment', { task_id: 'a1', text: 'x', in_list_id: '7001', list_path: path, in_task: 'Task' }));
    const changes = p.fields!.find((f) => f.name === 'Changes')!.value;
    expect(changes).toContain(path.replace(/[\\`*_~|>[\]()#]/g, '\\$&'));
    expect(p.fields!.some((f) => f.name === 'Note')).toBe(false);
  });
  it('a maximum-length name (110) on create is the card Target, whole', () => {
    const p = toolApprovalPayload(mk(1, 'clickup_create_task', { list_id: '7001', name: 'N'.repeat(110), ...PIN }));
    expect(p.fields!.find((f) => f.name === 'Target')!.value).toBe('N'.repeat(110));
    expect(p.fields!.some((f) => f.name === 'Note')).toBe(false);
  });
});

describe('C1b the whole-card check is worst case: a tainted run\'s long central reason cannot push a passing card over 6000', () => {
  it('a body that fits with our short reason but not with a 300-character escaping reason is refused in a tainted context', async () => {
    const fits = (n: number, reason: string, requestedBy: string) => cardShowsWhole({ ...mk(1, 'clickup_add_comment', { task_id: 'a1', text: '\\'.repeat(n), ...PIN }), reason, requestedBy });
    let edge = 0;
    for (let n = 900; n <= 1500; n += 5) if (fits(n, 'ClickUp workspace write: every change needs approval', 'head:software') && !fits(n, '['.repeat(300), '['.repeat(64))) edge = n;
    expect(edge, 'there is a body size that only the worst case refuses').toBeGreaterThan(0);
    const state = ws();
    const client = createClickUpClient({ http: createHttpClient({ fetch: workspaceFetch(state) }), token: state.token, teamId: '9001' });
    const g = clickupGroup({ clickup: client, clickupUsage: { take: async () => true }, cfg: new FakeConfig(), log: { warn: () => undefined }, clock: Date.now } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('off');
    const { reg, c, approvals } = await webRig(g.tools, { direct: false, origin: 'delegated', tainted: () => true });
    const r = await reg.run('clickup_add_comment', { task_id: 'a1', text: '\\'.repeat(edge) }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('too long or too complex');
    expect(approvals.request).not.toHaveBeenCalled();
  });
});

describe('G2CW-01 (C5) a body the card would mask in one chunk only is not shown whole', () => {
  it('a pattern that starts at a chunk boundary (Cookie:, key=, Bot) makes cardShowsWhole false, though the whole text is not redacted', () => {
    for (const tail of ['Cookie: hidden text the approver would not see', 'key=HIDDENVALUE123456', 'Bot abcdefghijklmnopqrstuvwxyz0123']) {
      const text = 'x'.repeat(249) + tail; // the JSON quote makes chunk 1 exactly 250 units, so chunk 2 starts with the tail
      expect(cardShowsWhole(mk(1, 'clickup_add_comment', { task_id: 'a1', text, ...PIN })), tail).toBe(false);
    }
    expect(cardShowsWhole(mk(1, 'clickup_add_comment', { task_id: 'a1', text: `${'x'.repeat(249)}plain words`, ...PIN }))).toBe(true);
  });
  it('JSON quoting can start a match the raw text lacks (`\\n` -> `\\` + `n` makes a 24-unit run): Body and one-line batch values are checked too', () => {
    const tok = (sep: string) => `hi${sep}${'b'.repeat(23)}.${'c'.repeat(6)}.${'d'.repeat(27)}`;
    for (const sep of ['\n', '\t']) {
      expect(cardShowsWhole(mk(1, 'clickup_add_comment', { task_id: 'a1', text: tok(sep), ...PIN })), `body ${JSON.stringify(sep)}`).toBe(false);
      expect(cardShowsWhole(mk(1, 'clickup_create_task', { list_id: '7001', name: tok(sep), ...PIN })), `batch name ${JSON.stringify(sep)}`).toBe(false);
      expect(cardShowsWhole(mk(1, 'clickup_update_status', { task_id: 'a1', status: tok(sep), ...PIN })), `batch status ${JSON.stringify(sep)}`).toBe(false);
    }
  });
  it('a pinned value the card would mask (a list named like a credential) is not shown whole either', () => {
    expect(cardShowsWhole(mk(1, 'clickup_add_comment', { task_id: 'a1', text: 'hi', in_list_id: '7001', list_path: 'S / token=abcdef [abc123]' }))).toBe(false);
  });
});

describe('CM-C6 (CLICKUP-MULTI-1) the four workspace pins never make a card cut', () => {
  const PINS4 = { ...PIN, in_task: 'T'.repeat(100), in_workspace: `${'W'.repeat(30)}… [abcdef]` };
  const worst = { task_id: 'a1', name: 'N'.repeat(110), description: 'd'.repeat(1500), due_date: '2026-12-01', clear_due_date: true, priority: 1, clear_priority: true, ...PINS4 };
  const withReason = (a: Approval): Approval => ({ ...a, reason: '['.repeat(500), requestedBy: '['.repeat(64), taskId: '['.repeat(64) });

  it('clickup_update_task with every optional field and all four pins (worst-case 500-character escaping reason): cut is false, solo and batch, within Discord limits', () => {
    const a = withReason(mk(1, 'clickup_update_task', worst));
    const l = limits(a);
    expect(l.cut).toBe(false);
    expect(l.count).toBeLessThanOrEqual(25);
    expect(l.longest).toBeLessThanOrEqual(1024);
    expect(l.total).toBeLessThanOrEqual(6000);
    expect(cardShowsWhole(a)).toBe(true);
    // the batch item (one line per call; a long body is never batched, B2): every field and the four pins, no body
    const { description: _d, ...noBody } = worst;
    expect(compactItemFits(mk(1, 'clickup_update_task', noBody))).toBe(true);
    const batch = buildMessage(batchApprovalPayload([mk(1, 'clickup_update_task', noBody)], { id: 5, digest: 'abcdef012345' }), { deptColor: 0 });
    expect(batch[0]!.embeds[0]!.fields![0]!.value).not.toContain('truncated');
  });
  it('the workspace pin is rendered whole on the solo card, next to the other pins', () => {
    const changes = toolApprovalPayload(mk(1, 'clickup_add_comment', { task_id: 'a1', text: 'x', ...PINS4 })).fields!.find((f) => f.name === 'Changes')!.value;
    expect(changes).toContain('in\\_workspace');
    expect(changes).toContain('abcdef');
  });
  it('a call WITHOUT the pin keeps the old rule: more than 8 plain fields is cut', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']));
    expect(limits(mk(1, 'some_tool', many)).cut).toBe(true);
    // and the nine fields of a workspace-pinned call still count: five plain fields plus four pins is fine, nine plain fields plus the pins is cut
    expect(limits(mk(1, 'clickup_update_task', { ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])), ...PINS4 })).cut).toBe(true);
  });
});

describe('CLICKUP-HIER-1: the create cards (pins without in_list_id)', () => {
  const HPIN = { in_folder_id: 'f501', parent_path: 'Engineering / Backend [abc123]' };
  it('a 1500-unit create_list description is shown whole on the solo card (Body, cut false) and is NOT batch-eligible', () => {
    const a = mk(1, 'clickup_create_list', { folder_id: 'f501', name: 'Sprint', description: 'd'.repeat(1500), ...HPIN });
    const l = limits(a);
    expect(l.cut).toBe(false);
    expect(cardShowsWhole(a)).toBe(true);
    expect(toolApprovalPayload(a).fields!.some((f) => f.name === 'Body')).toBe(true);
    expect(compactItemFits(a)).toBe(false);
  });
  it('a short create_list description renders whole as a batch item', () => {
    const a = mk(1, 'clickup_create_list', { folder_id: 'f501', name: 'Sprint', description: 'short text', ...HPIN });
    expect(compactItemFits(a)).toBe(true);
    const b = batchApprovalPayload([a, mk(2, 'clickup_create_folder', { space_id: '501', name: 'F', in_space_id: '501', parent_path: 'Engineering [abc123]' })], { id: 5, digest: 'abcdef012345' });
    expect(JSON.stringify(b.fields)).toContain('short text');
  });
  it('the new pins are shown whole and never count toward the field cap', () => {
    const p = toolApprovalPayload(mk(1, 'clickup_create_list', { space_id: '501', name: 'L', description: 'x', in_space_id: '501', parent_path: 'Engineering [abc123]', in_workspace: 'Core [abc123]' }));
    const changes = p.fields!.find((f) => f.name === 'Changes')!.value;
    for (const k of ['in_space_id', 'parent_path', 'in_workspace']) expect(changes).toContain(k.replace(/_/g, '\\_'));
    expect(p.fields!.some((f) => f.name === 'Note')).toBe(false);
  });
  it('a create_space is workspace-pinned by in_workspace alone (the pin is shown, not counted)', () => {
    const p = toolApprovalPayload(mk(1, 'clickup_create_space', { name: 'Alpha', in_workspace: 'Core [abc123]' }));
    expect(p.fields!.find((f) => f.name === 'Target')!.value).toBe('Alpha');
    expect(p.fields!.find((f) => f.name === 'Changes')!.value).toContain('in\\_workspace');
  });
  it('a list-mode style call without any pin keeps its old rendering (no Body for create_list)', () => {
    const p = toolApprovalPayload(mk(1, 'clickup_create_list', { space_id: '501', name: 'L', description: 'd'.repeat(500) }));
    expect(p.fields!.some((f) => f.name === 'Body')).toBe(false);
  });
});

