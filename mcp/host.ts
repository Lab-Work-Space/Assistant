import type { McpClass, McpRepo, McpRow } from '../db/repos/mcp.js';
import { classOf } from '../tools/manifest/catalog.js';
import { MCP_NAME } from '../tools/manifest/external.js';
import type { ToolPlugin } from '../tools/types.js';
import { McpError } from './errors.js';
import { buildSnapshot, configSha256 } from './snapshot.js';
import type { ToolInput } from './schema.js';

/**
 * R6 MCP-1: the live, in-memory view of the active MCP servers (spec 5.1, 5.8). It is rebuilt from the database by `load()` and `refresh()`; a read error holds nothing
 * (fail closed). Every object handed out is frozen. The registry (BE2) reads it through `get` and `names`; the policy reads `mcpFor`. For each plugin the host asserts
 * MCP_NAME, `classOf(name).group === 'mcp'` and `classOf(name).kind === plugin.kind`: a server that fails any of them is not loaded at all and an incident is raised.
 */
export interface HostTool { readonly name: string; readonly orig: string; readonly description: string; readonly schema: ToolInput }
export interface HostServer {
  readonly id: number; readonly slug: string; readonly cls: McpClass; readonly imageId: string; readonly command: readonly string[]; readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number; readonly maxCallsPerDay: number; readonly hash: string; readonly depts: readonly string[];
}
export interface HostEntry { readonly server: HostServer; readonly tool: HostTool; readonly plugin: ToolPlugin }

export interface HostDeps {
  repo: Pick<McpRepo, 'activeRows'>;
  /** Builds the plugin for one tool of one server (tool.ts `createMcpToolFactory`). */
  makeTool(server: HostServer, tool: HostTool): ToolPlugin;
  secrets(): readonly string[];
  /** 047: a row whose stored config no longer hashes to its approved pin (or has none). Called while the load runs (never refresh from it); `quarantineConfig` is the implementation. Never throws out of the host. */
  onConfigChanged?(row: McpRow): Promise<unknown>;
  /** A fixed code and the slug (never text): a server that could not be loaded. */
  incident(code: string, slug: string): void;
  log: { error(o: unknown, m?: string): void };
}
export type LoadResult = { loaded: number; failed: string[] };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');
const MAX_TIMEOUT_MS = 120_000;

export class McpHost {
  private entries: ReadonlyMap<string, HostEntry> = new Map();
  private servers: readonly HostServer[] = [];
  private excluded: ReadonlySet<string> = new Set();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: HostDeps) {}

  /** Rebuilds from the database. `exclude`: slugs that boot found unusable (image missing); they stay out across `refresh`. Never throws. */
  load(exclude?: ReadonlySet<string>, cancelled?: () => boolean): Promise<LoadResult> {
    if (exclude) this.excluded = new Set(exclude);
    const run = this.chain.then(() => this.build(cancelled), () => this.build(cancelled));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** G2-MCP-03: empties the host at once (boot's cap fired). A load that was cancelled with it cannot fill it again; a later, uncancelled load can. */
  clear(): void {
    this.entries = new Map();
    this.servers = [];
  }

  /** `slug` (G2-MCP-06): a Bot Admin action just proved this server usable (approve, or `/mcp test` ok), so a boot-time exclusion of it ends; the rest stays as it was. */
  async refresh(slug?: string): Promise<void> {
    if (slug !== undefined && this.excluded.has(slug)) { const e = new Set(this.excluded); e.delete(slug); this.excluded = e; }
    await this.load();
  }

  private fail(failed: string[], code: string, slug: string): void {
    failed.push(slug);
    try { this.d.incident(code, slug); } catch { /* an incident hook never stops a load */ }
  }

  private async build(cancelled?: () => boolean): Promise<LoadResult> {
    let rows: McpRow[];
    try {
      rows = await this.d.repo.activeRows();
    } catch (e) {
      this.clear();
      this.d.log.error({ errName: errName(e) }, 'mcp host read failed');
      return { loaded: 0, failed: [] };
    }
    const entries = new Map<string, HostEntry>();
    const servers: HostServer[] = [];
    const failed: string[] = [];
    for (const row of rows) {
      if (this.excluded.has(row.slug)) continue;
      try {
        // 047: the pin first. A row edited behind the approval (image, command, env, class, grants, snapshot hash) is never built, never spawned; it is quarantined.
        if (row.approvedConfigSha256 === null || row.approvedConfigSha256 !== configSha256(row)) {
          failed.push(row.slug);
          try { await this.d.onConfigChanged?.(row); } catch { /* a hook never stops a load */ }
          continue;
        }
        if (row.timeoutMs > MAX_TIMEOUT_MS || row.timeoutMs < 1) { this.fail(failed, 'timeout', row.slug); continue; }
        const built = buildSnapshot(row.snapshot, { slug: row.slug, toolClass: row.toolClass, secrets: this.d.secrets() });
        if (built.sha256 !== row.snapshotSha256) { this.fail(failed, 'snapshot_mismatch', row.slug); continue; }
        const server: HostServer = Object.freeze({
          id: row.id, slug: row.slug, cls: row.toolClass, imageId: row.imageId, command: Object.freeze([...row.command]), env: Object.freeze({ ...row.env }),
          timeoutMs: row.timeoutMs, maxCallsPerDay: row.maxCallsPerDay, hash: row.snapshotSha256, depts: Object.freeze([...row.depts]),
        });
        const made: [string, HostEntry][] = [];
        let bad: string | null = null;
        for (const e of built.entries) {
          const tool: HostTool = Object.freeze({ name: e.name, orig: e.orig, description: e.description, schema: e.schema });
          const plugin = this.d.makeTool(server, tool);
          const c = classOf(plugin.name);
          if (!MCP_NAME.test(plugin.name) || plugin.name !== e.name) { bad = 'plugin_name'; break; }
          if (c.group !== 'mcp' || c.kind !== (plugin.kind ?? null) || c.kind !== server.cls) { bad = 'plugin_kind'; break; }
          made.push([e.name, Object.freeze({ server, tool, plugin })]);
        }
        if (bad !== null) { this.fail(failed, bad, row.slug); continue; }
        for (const [n, en] of made) entries.set(n, en);
        servers.push(server);
      } catch (e) {
        this.d.log.error({ errName: errName(e) }, 'mcp host build failed');
        this.fail(failed, e instanceof McpError ? `build_${e.code}` : 'build', row.slug);
      }
    }
    if (cancelled?.()) return { loaded: 0, failed }; // synchronous with the assignment below: a late load of a boot that already reported off leaves the host as `clear` left it
    this.entries = entries;
    this.servers = servers;
    return { loaded: servers.length, failed };
  }

  get(name: string): ToolPlugin | undefined {
    return this.entries.get(name)?.plugin;
  }

  entry(name: string): HostEntry | undefined {
    return this.entries.get(name);
  }

  names(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  /** The names of the active servers' tools granted to a department (spec 5.8). */
  mcpFor(dept: string): string[] {
    const out: string[] = [];
    for (const [n, e] of this.entries) if (e.server.depts.includes(dept)) out.push(n);
    return out.sort();
  }
}
