import type { McpRepo } from '../db/repos/mcp.js';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

/**
 * R6 MCP-1 (migration 047): a stored row that no longer hashes to the config a Bot Admin approved is quarantined with the reason `config_changed`. Shared by the host
 * (at load and refresh) and the tool adapter (per call). Compare-and-set in the repo: a stale call changes nothing and writes no row. Never throws; nothing here
 * carries row text, only the slug and fixed words.
 */
export const CONFIG_NOTICE = (slug: string): string => `MCP server ${slug} was quarantined: its stored configuration no longer matches what a Bot Admin approved. A Bot Admin must re-add and re-approve it.`;

export interface ConfigQuarantineDeps {
  repo: Pick<McpRepo, 'quarantine'>;
  /** The fixed #bot-log notice (code text only). Never throws. */
  notify(text: string): Promise<void>;
  /** The approval ids the quarantine expired, so BE2 can close their cards. */
  closeCards?: (ids: number[]) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
}

/** True when this call quarantined the row. The caller refreshes the host when it is not already inside a load. */
export async function quarantineConfig(d: ConfigQuarantineDeps, row: { id: number; slug: string; snapshotSha256: string }): Promise<boolean> {
  try {
    const q = await d.repo.quarantine({ id: row.id, slug: row.slug, snapshotSha256: row.snapshotSha256, reason: 'config_changed' });
    if (!q.ok) return false;
    if (q.expired.length > 0) await d.closeCards?.(q.expired).catch(() => undefined);
    await d.notify(CONFIG_NOTICE(row.slug)).catch(() => undefined);
    return true;
  } catch (e) {
    d.log.error({ errName: errName(e) }, 'mcp config quarantine failed');
    return false;
  }
}
