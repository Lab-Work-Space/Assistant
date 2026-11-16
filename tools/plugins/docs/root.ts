import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * D-04: where department documents (HR, finance, tax files) are kept. It is never derived from Praw's workspace root (that could land in ~/Documents or
 * another synced folder). `DOCS_DIR` (absolute) or, unset, `<cwd>/data/documents` (the same convention as data/workspace). An explicit value is refused when it is
 * $HOME itself or directly under it, under ~/Documents, ~/Desktop, ~/Library/Mobile Documents or ~/Library/CloudStorage (compared case-insensitively),
 * or when it is Praw's workspace root, inside it, or contains it. The default is only checked against the workspace (a checkout may live under ~/Desktop).
 */
export const DEFAULT_DOCS_DIR = 'data/documents';

const lower = (p: string): string => p.toLowerCase();
const inside = (child: string, parent: string): boolean => {
  const r = relative(lower(parent), lower(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r) && !r.startsWith(`..${sep}`));
};

export function docsRoot(o: { docsDir?: string | undefined; workspaceRoot: string; cwd?: string; home?: string }): { ok: true; root: string } | { ok: false; why: string } {
  const home = resolve(o.home ?? homedir());
  const explicit = o.docsDir !== undefined;
  if (explicit && !isAbsolute(o.docsDir!)) return { ok: false, why: 'DOCS_DIR must be an absolute path' };
  const root = resolve(explicit ? o.docsDir! : join(o.cwd ?? process.cwd(), DEFAULT_DOCS_DIR));
  const ws = resolve(o.workspaceRoot);
  if (inside(root, ws) || inside(ws, root)) return { ok: false, why: "the documents folder must not be Praw's workspace root, inside it or contain it" };
  if (explicit) {
    if (lower(root) === lower(home) || lower(resolve(root, '..')) === lower(home)) return { ok: false, why: 'the documents folder must not be the home folder or directly under it' };
    for (const sub of ['Documents', 'Desktop', join('Library', 'Mobile Documents'), join('Library', 'CloudStorage')]) {
      if (inside(root, join(home, sub))) return { ok: false, why: `the documents folder must not be under ~/${sub} (synced or shared folders)` };
    }
  }
  return { ok: true, root };
}
