import type { WorkspaceRepo, WorkspaceRow } from './workspaces.js';

/** In-memory WorkspaceRepo for unit tests. Conformance with the SQL repo is checked by the shared case table in workspaces.int.test.ts (backend rule 9). */
export class MemWorkspaceRepo implements Pick<WorkspaceRepo, 'create' | 'remove' | 'get' | 'list' | 'archive' | 'setUsage' | 'claim'> {
  readonly rows = new Map<string, WorkspaceRow>();
  private readonly counts = new Map<string, number>();

  async create(slug: string, title: string, createdBy: string): Promise<'ok' | 'limit' | 'exists'> {
    if ([...this.rows.values()].filter((r) => r.status === 'active').length >= 5) return 'limit'; // the SQL WHERE runs before the unique check
    if (this.rows.has(slug)) return 'exists';
    this.rows.set(slug, { slug, title, createdBy, status: 'active', bytes: 0, nmBytes: 0, createdAt: new Date() });
    return 'ok';
  }
  async remove(slug: string): Promise<void> {
    this.rows.delete(slug);
  }
  async get(slug: string): Promise<WorkspaceRow | null> {
    const r = this.rows.get(slug);
    return r ? { ...r } : null;
  }
  async list(): Promise<WorkspaceRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async archive(slug: string, _userId: string): Promise<boolean> {
    const r = this.rows.get(slug);
    if (!r || r.status !== 'active') return false;
    r.status = 'archived';
    return true;
  }
  async setUsage(slug: string, bytes: number, nmBytes: number | null): Promise<void> {
    const r = this.rows.get(slug);
    if (!r) return;
    r.bytes = Math.max(0, Math.floor(bytes));
    if (nmBytes !== null) r.nmBytes = Math.max(0, Math.floor(nmBytes));
  }
  async claim(treeKey: string, dayKey: string, treeCap: number, dayCap: number): Promise<'ok' | 'tree' | 'day'> {
    if (!Number.isInteger(treeCap) || treeCap < 1 || !Number.isInteger(dayCap) || dayCap < 1) return 'tree';
    const t = this.counts.get(`tree:${treeKey}`) ?? 0;
    if (t >= treeCap) return 'tree';
    const d = this.counts.get(`day:${dayKey}`) ?? 0;
    if (d >= dayCap) return 'day'; // nothing was written yet: the tree count is unchanged, as the SQL rollback
    this.counts.set(`tree:${treeKey}`, t + 1);
    this.counts.set(`day:${dayKey}`, d + 1);
    return 'ok';
  }
}
