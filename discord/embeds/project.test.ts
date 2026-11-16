import { describe, expect, it } from 'vitest';
import { toPayload } from '../../agents/loop/payload.js';
import { PROJECT_BUDGET_ID, PROJECT_CARD_ID, projectBudgetRow, projectCardRow } from './approval.js';
import { buildMessage, isCardPayload } from './index.js';

const TOKEN = 'cd'.repeat(16);
const ctx = { deptColor: 0x3498db, dept: 'hq' } as never;

describe('project card rows and payload (AUTO-1)', () => {
  it('custom ids carry only the token and the action; the regexes accept exactly those shapes', () => {
    const card = JSON.stringify(projectCardRow(TOKEN));
    expect(card).toContain(`projcard:${TOKEN}:approve`);
    expect(card).toContain(`projcard:${TOKEN}:reject`);
    expect(card).toContain('Approve project');
    const bud = JSON.stringify(projectBudgetRow(TOKEN));
    expect(bud).toContain(`projbud:${TOKEN}:raise`);
    expect(bud).toContain(`projbud:${TOKEN}:close`);
    expect(bud).toContain('Raise budget');
    expect(bud).toContain('Close project');
    expect(PROJECT_CARD_ID.exec(`projcard:${TOKEN}:approve`)?.[1]).toBe(TOKEN);
    expect(PROJECT_BUDGET_ID.exec(`projbud:${TOKEN}:close`)?.[2]).toBe('close');
    for (const bad of [`projcard:${TOKEN}:raise`, `projbud:${TOKEN}:approve`, `projcard:${TOKEN}:approve\n`, `projcard:${TOKEN.slice(1)}:approve`, `xprojcard:${TOKEN}:approve`]) {
      expect(PROJECT_CARD_ID.test(bad) || PROJECT_BUDGET_ID.test(bad), bad).toBe(false);
    }
  });
  it('the payloads are cards (not plain chat) and render with their button row on the last message', () => {
    const a = { type: 'approval', origin: 'governance', title: 'Project proposal', body: 'b', projectCardId: TOKEN } as const;
    const b = { type: 'approval', origin: 'governance', title: 'Project budget used up', body: 'b', projectBudgetId: TOKEN } as const;
    expect(isCardPayload(a)).toBe(true);
    expect(isCardPayload(b)).toBe(true);
    expect(isCardPayload({ type: 'chat', body: 'x', projectCardId: TOKEN })).toBe(true);
    const ma = buildMessage(a, ctx);
    expect(JSON.stringify(ma.at(-1)!.components)).toContain(`projcard:${TOKEN}:approve`);
    const mb = buildMessage(b, ctx);
    expect(JSON.stringify(mb.at(-1)!.components)).toContain(`projbud:${TOKEN}:raise`);
  });
  it('toPayload (model output) drops projectCardId and projectBudgetId', () => {
    const p = toPayload({ type: 'approval', body: 'x', projectCardId: TOKEN, projectBudgetId: TOKEN, toolRequestId: TOKEN });
    expect(p).toEqual({ type: 'chat', body: 'x' });
    expect('projectCardId' in p).toBe(false);
    expect('projectBudgetId' in p).toBe(false);
  });
});
