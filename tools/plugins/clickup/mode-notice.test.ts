import { describe, expect, it } from 'vitest';
import { modeNeedsNotice } from './mode-notice.js';

describe('HEAL-1 H5 / HL-C19: the ClickUp mode notice once', () => {
  it('same mode as the latest row: no notice', async () => {
    expect(await modeNeedsNotice('workspace', async () => 'workspace')).toBe(false);
    expect(await modeNeedsNotice('workspace-all', async () => 'workspace-all')).toBe(false);
  });
  it('changed mode, no row, or an unexpected outcome text: notice', async () => {
    expect(await modeNeedsNotice('workspace', async () => 'workspace-all')).toBe(true);
    expect(await modeNeedsNotice('workspace-all', async () => 'workspace')).toBe(true);
    expect(await modeNeedsNotice('workspace', async () => null)).toBe(true);
    expect(await modeNeedsNotice('workspace', async () => 'workspace 3')).toBe(true);
  });
  it('a read error: notice', async () => {
    expect(await modeNeedsNotice('workspace', async () => { throw new Error('db down'); })).toBe(true);
  });
});
