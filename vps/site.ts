import { Workspace, openInWorkspace } from '../tools/plugins/workspace/sandbox.js';
import { packFiles, STATIC_LIMITS, type StaticFile } from './static.js';

/**
 * `site_publish_static` support: packs a folder of Praw's sandboxed workspace (PRAW_WORKSPACE_DIR) into the one archive form the VPS accepts.
 * Reads go through the workspace sandbox (no symlinks, no escape, files re-checked while open); dotfiles, odd types and secrets refuse the pack.
 */
export type Packed = { ok: true; tar: Buffer; sha256: string; size: number; files: number } | { ok: false; error: string };

export async function packWorkspaceDir(root: string, dir: string): Promise<Packed> {
  const ws = new Workspace(root);
  const files: StaticFile[] = [];
  const walk = async (rel: string, depth: number): Promise<string | null> => {
    if (depth > STATIC_LIMITS.depth) return 'the folder is nested too deep';
    let rows;
    try { rows = await ws.list(rel); } catch { return `${rel || 'the workspace'} cannot be read`; }
    for (const e of rows) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.kind === 'other') return `${child}: only plain files and folders can be published`;
      if (e.kind === 'dir') {
        const why = await walk(child, depth + 1);
        if (why) return why;
      } else {
        if (files.length >= STATIC_LIMITS.files) return `at most ${STATIC_LIMITS.files} files`;
        try {
          const h = await openInWorkspace(root, child, 'r');
          try {
            if (h.size > STATIC_LIMITS.fileBytes) return `${child}: a file is at most ${STATIC_LIMITS.fileBytes / 1024 / 1024} MiB`;
            const buf = Buffer.alloc(h.size);
            const { bytesRead } = await h.fh.read(buf, 0, h.size, 0);
            // paths inside the archive are relative to the published folder, so the site root is the folder itself
            files.push({ path: dir === '' ? child : child.slice(dir.length + 1), data: buf.subarray(0, bytesRead) });
          } finally {
            await h.fh.close();
          }
        } catch (e) {
          return `${child}: ${e instanceof Error ? e.message.slice(0, 80) : 'cannot be read'}`;
        }
      }
    }
    return null;
  };
  const why = await walk(dir, 1);
  if (why) return { ok: false, error: why };
  const p = packFiles(files);
  return p.ok ? { ...p, files: files.length } : p;
}
