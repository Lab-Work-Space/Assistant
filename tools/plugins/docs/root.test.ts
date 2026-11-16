import { describe, expect, it } from 'vitest';
import { docsRoot } from './root.js';

const home = '/Users/alice';
const ws = '/srv/app/data/workspace/praw';
const chk = (docsDir: string | undefined, extra: { workspaceRoot?: string; cwd?: string } = {}) => docsRoot({ docsDir, workspaceRoot: ws, cwd: '/srv/app', home, ...extra });

describe('D-04 department documents root', () => {
  it('defaults to <cwd>/data/documents (a sibling of data/workspace, outside Praw\'s root), even when the checkout is under ~/Desktop', () => {
    expect(chk(undefined)).toEqual({ ok: true, root: '/srv/app/data/documents' });
    expect(docsRoot({ docsDir: undefined, workspaceRoot: '/Users/alice/Desktop/L/data/workspace/praw', cwd: '/Users/alice/Desktop/L', home })).toEqual({ ok: true, root: '/Users/alice/Desktop/L/data/documents' });
  });
  it('accepts an explicit absolute folder elsewhere', () => {
    expect(chk('/var/lib/docs')).toEqual({ ok: true, root: '/var/lib/docs' });
    expect(chk('/Users/alice/work/docs')).toEqual({ ok: true, root: '/Users/alice/work/docs' });
  });
  it('refuses $HOME itself and anything directly under it, case-insensitively', () => {
    for (const d of ['/Users/alice', '/users/ALICE', '/Users/alice/docs', '/Users/ALICE/Docs', '/Users/alice/']) expect(chk(d).ok, d).toBe(false);
  });
  it('refuses ~/Documents, ~/Desktop, iCloud and CloudStorage folders and anything inside them, case-insensitively', () => {
    for (const d of ['/Users/alice/Documents', '/Users/alice/documents/x/y', '/Users/alice/Desktop/a/b', '/Users/ALICE/DESKTOP/a', '/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/x', '/Users/alice/library/cloudstorage/Dropbox/x']) expect(chk(d).ok, d).toBe(false);
  });
  it("refuses Praw's workspace root, anything inside it, and a folder that contains it", () => {
    for (const d of [ws, `${ws}/docs`, ws.toUpperCase(), '/srv/app/data', '/srv/app']) expect(chk(d).ok, d).toBe(false);
  });
  it('refuses a relative path', () => {
    expect(chk('data/documents').ok).toBe(false);
  });
});
