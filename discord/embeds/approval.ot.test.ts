import { describe, expect, it } from 'vitest';
import { buildMessage } from './index.js';
import { escapeCardText, otCustomId, otGrantedNote, otGrantedPayload, otRequestPayload, OT_DAY_LABEL, OT_ID, parseOtCustomId, type OtCardView } from './approval.js';
import { APPROVAL_ID } from '../commands/approval.js';
import { BATCH_APPROVAL_ID, REVOKE_ID } from './approval.js';

const REQUESTER = '123456789012345678';
const view = (over: Partial<OtCardView> = {}): OtCardView => ({
  id: 7, digest: 'abcdef012345', rootId: 'task-1', rootTitle: 'Quarterly report', threadId: '1570000000000000009', requestedBy: REQUESTER,
  held: { tasks: 2, depts: ['Software', 'Finance'], rollups: 1, botTalk: 0 }, spentUsd: 0.25, until: new Date('2026-11-07T10:00:00Z'), maxRuns: 30, maxUsd: 2, ...over,
});
const render = (v: OtCardView) => buildMessage(otRequestPayload(v, []), { deptColor: 0 });
const ids = (v: OtCardView) => JSON.stringify(render(v)[0]!.components);

describe('OT-1 card render', () => {
  it('is ONE message with ONE embed (so it can be edited in place) and carries the three decision buttons with the stored id and digest', () => {
    const m = render(view());
    expect(m).toHaveLength(1);
    expect(m[0]!.embeds).toHaveLength(1);
    const c = ids(view());
    for (const a of ['approve', 'deny', 'day']) expect(c).toContain(`approval:ot:7:abcdef012345:${a}`);
    expect(c).not.toContain(':revoke');
    expect(m[0]!.embeds[0]!.title).toBe('OT request #7');
  });

  it('shows the task tree, the requesting person (a no-ping mention), why, what is held, spend and the cap; never the holiday name', () => {
    const e = render(view())[0]!;
    const fields = Object.fromEntries(e.embeds[0]!.fields!.map((f) => [f.name, f.value]));
    expect(fields['Task tree']).toContain('Quarterly report');
    expect(fields['Task tree']).toContain('task-1');
    expect(fields['Task tree']).toContain('<#1570000000000000009>');
    expect(fields['Requested by']).toBe(`<@${REQUESTER}>`);
    expect(fields['Why']).toBe('Today is an off day (weekly or holiday).');
    expect(fields['Held now']).toBe('2 tasks (Software, Finance); 1 roll-up');
    expect(fields['Spent so far']).toContain('$0.2500');
    expect(fields['If approved']).toMatch(/up to 30 runs, up to \$2\.00/);
    expect(e.allowedMentions).toEqual({ parse: [] }); // OT-C9/OT-C10: a mention inside a field never pings
    expect(e.content).toBeUndefined();
  });

  it('OT-C17: the whole-day button says it opens all work', () => {
    expect(OT_DAY_LABEL).toBe('Make today a workday (all work)');
    expect(ids(view())).toContain(OT_DAY_LABEL);
  });

  it('after an approval the card shows the grant as its content and a Revoke button only', () => {
    const p = otGrantedPayload(view(), { by: REQUESTER, until: new Date('2026-11-07T10:00:00Z'), runsUsed: 0, maxRuns: 30, maxUsd: 2 });
    const m = buildMessage(p, { deptColor: 0 });
    expect(m).toHaveLength(1);
    expect(m[0]!.embeds).toHaveLength(1);
    expect(m[0]!.content).toBe(otGrantedNote({ by: REQUESTER, until: new Date('2026-11-07T10:00:00Z'), runsUsed: 0, maxRuns: 30, maxUsd: 2 }));
    expect(m[0]!.content).toMatch(/runs 0\/30, up to \$2\.00/);
    expect(m[0]!.allowedMentions).toEqual({ parse: [] });
    const c = JSON.stringify(m[0]!.components);
    expect(c).toContain('approval:ot:7:abcdef012345:revoke');
    expect(c).not.toContain(':approve');
  });
});

describe('OT-1 OT-C10: the root title is inert', () => {
  const hostile = '@everyone <@123456789012345678> [x](https://evil.example) ‮​```code``` **bold**';
  it('mentions, masked links, bidi and zero-width characters, code fences and markdown cannot act on the card', () => {
    const e = render(view({ rootTitle: hostile }))[0]!;
    const tree = e.embeds[0]!.fields!.find((f) => f.name === 'Task tree')!.value;
    expect(tree).not.toContain('@everyone');
    expect(tree).toContain('@​everyone');
    expect(tree).not.toMatch(/<@\d/); // the user mention is escaped
    expect(tree).toContain('\\<@');
    expect(tree).not.toContain('](https://evil.example)'); // the masked link is broken
    expect(tree).not.toContain('‮');
    expect(tree).toContain('\\u{202E}'); // visible instead
    expect(tree).toContain('\\u{200B}');
    expect(tree).not.toContain('```');
    expect(tree).not.toContain('**bold**');
    expect(e.allowedMentions).toEqual({ parse: [] });
  });

  it('two calls in a row on the same hidden-character input give the same result (no global-regex state)', () => {
    const a = escapeCardText(hostile, 100);
    const b = escapeCardText(hostile, 100);
    expect(b).toBe(a);
    expect(render(view({ rootTitle: hostile }))[0]!.embeds[0]!.fields![0]).toEqual(render(view({ rootTitle: hostile }))[0]!.embeds[0]!.fields![0]);
  });

  it('a secret literal in the title is masked, and a long title is cut', () => {
    const p = otRequestPayload(view({ rootTitle: 'deploy with sk-live-ABCDEFGH12345678 now' }), ['sk-live-ABCDEFGH12345678']);
    expect(JSON.stringify(p)).not.toContain('sk-live-ABCDEFGH12345678');
    const long = otRequestPayload(view({ rootTitle: 'x'.repeat(500) }), []);
    expect(long.fields![0]!.value.length).toBeLessThan(250);
  });

  it('a requester that is not a user id is shown escaped, never as a mention', () => {
    const f = otRequestPayload(view({ requestedBy: '@everyone <@1>' }), []).fields!.find((x) => x.name === 'Requested by')!;
    expect(f.value).not.toMatch(/<@\d|@everyone/);
  });
});

describe('OT-1 custom ids', () => {
  it('parse and build agree, and the OT shape cannot match any other approval id shape (and none match it)', () => {
    const id = otCustomId(12, 'abcdef012345', 'day');
    expect(id).toBe('approval:ot:12:abcdef012345:day');
    expect(parseOtCustomId(id)).toEqual({ id: 12, digest: 'abcdef012345', action: 'day' });
    for (const re of [APPROVAL_ID, BATCH_APPROVAL_ID, REVOKE_ID]) expect(re.test(id)).toBe(false);
    for (const other of ['approval:5:approve', 'approval:b:5:abcdef012345:approve', 'approval:g:5:revoke']) expect(OT_ID.test(other), other).toBe(false);
  });

  it('malformed shapes do not parse', () => {
    for (const bad of [
      'approval:ot:', 'approval:ot:1:abcdef012345', 'approval:ot:1:abcdef012345:approve:extra', 'approval:ot:x:abcdef012345:approve', 'approval:ot:1:ABCDEF012345:approve',
      'approval:ot:1:abcdef01234:approve', 'approval:ot:1:abcdef0123456:approve', 'approval:ot:1:abcdef012345:reject', 'approval:ot:-1:abcdef012345:approve',
      'approval:ot:1234567890123456:abcdef012345:approve', 'xapproval:ot:1:abcdef012345:approve', 'approval:ot:1:abcdef012345:approve\n',
    ]) expect(parseOtCustomId(bad), bad).toBeNull();
  });
});
