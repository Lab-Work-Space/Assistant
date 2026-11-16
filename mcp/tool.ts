import { redactText } from '../core/logger.js';
import type { McpRepo } from '../db/repos/mcp.js';
import { canonicalJson } from '../governance/canonical.js';
import type { AuditFn } from '../governance/audit.js';
import { actorKey } from '../governance/budget.js';
import type { ToolContext, ToolPlugin, ToolResult } from '../tools/types.js';
import { MCP_TEXT, McpError, type CallCode } from './errors.js';
import type { HostEntry, HostServer, HostTool, McpHost } from './host.js';
import { processResult } from './output.js';
import { withSandbox, type SandboxDeps } from './sandbox.js';
import { hasHidden } from './screen.js';
import type { Slots } from './slots.js';
import { quarantineConfig } from './quarantine.js';
import { configSha256, hashRaw } from './snapshot.js';

/**
 * R6 MCP-1: the adapter that turns one tool of one active server into a ToolPlugin (spec 3.4). The registry order is unchanged: allowlist, zod, precheck, approval,
 * run. The class decides approval: read none, write always a card. The output is untrusted (the registry wraps it with source `mcp` and taints the run and the task).
 * Claim first (counters and the `mcp.call` start row in ONE transaction), then the container; the slot is never refunded and nothing is retried.
 * Nothing here logs a model string, server text, stderr or a zod error: only error names and codes (MC-C18).
 */
export interface McpToolDeps {
  host: Pick<McpHost, 'entry' | 'refresh'>;
  repo: Pick<McpRepo, 'claim' | 'quarantine' | 'get'>;
  sandbox: SandboxDeps;
  slots: Slots;
  /** `mcp.enabled`: read at each use; only exactly `true` is on and a throw counts as off. */
  enabled(): unknown;
  halted(): boolean;
  /** `schedule.timezone`, for the day keys. */
  tz(): string;
  /** `mcp.maxCallsPerTree` and `mcp.maxCallsPerDay`, read just before each claim. */
  caps(): { tree: number; day: number };
  audit: AuditFn;
  secrets(): readonly string[];
  /** The fixed #bot-log notice (code text only). Never throws. */
  notify(text: string): Promise<void>;
  /** The approval ids a quarantine expired, so BE2 can close their cards. */
  closeCards?: (ids: number[]) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
  now?: () => Date;
}

export const INPUT_MAX = 8000;
export const QUARANTINE_NOTICE = (slug: string): string => `MCP server ${slug} was quarantined: its tool list changed since it was approved. A Bot Admin must re-add and re-approve it.`;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');
const fail = (code: CallCode): ToolResult => ({ content: MCP_TEXT[code], isError: true });
const CAP = { tree: 'E_CAP_TREE', day: 'E_CAP_DAY', server: 'E_CAP_SERVER' } as const;

/**
 * The input screen (spec 3.4, MC-C5): true when the validated input may go to the server. It refuses any string the redactor would change, any string that
 * INVISIBLE or HIDDEN matches (on the raw string), and canonical input JSON over 8000 characters or one that cannot be serialised.
 */
export function screenInput(value: unknown, secrets: readonly string[]): boolean {
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (typeof v === 'string') return !hasHidden(v) && redactText(v, secrets) === v;
    if (Array.isArray(v)) return v.every((x) => walk(x, depth + 1));
    if (typeof v === 'object' && v !== null) return Object.keys(v).every((k) => walk((v as Record<string, unknown>)[k], depth + 1));
    return true;
  };
  if (!walk(value, 0)) return false;
  try {
    return canonicalJson(value).length <= INPUT_MAX;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` in the schedule timezone; an invalid zone throws RangeError (the caller maps it to E_CAP_DAY). */
export const dayOf = (tz: string, now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/**
 * 047, per call: re-reads the row with its grants (one read-only transaction) and recomputes the full config hash. Null when it equals the stored pin; else a refusal.
 * A row that is gone or no longer active is E_GONE; a row that does not match its pin (or has none) is quarantined (`config_changed`) and E_CONFIG. A read error refuses (E_INTERNAL).
 */
async function configRefusal(d: McpToolDeps, srv: HostServer): Promise<string | null> {
  let row: Awaited<ReturnType<McpRepo['get']>>;
  try { row = await d.repo.get(srv.slug); } catch (err) { d.log.error({ errName: errName(err) }, 'mcp config check failed'); return MCP_TEXT.E_INTERNAL; }
  if (!row || row.id !== srv.id || row.status !== 'active') return MCP_TEXT.E_GONE;
  if (row.approvedConfigSha256 !== null && row.approvedConfigSha256 === configSha256(row)) {
    // G2-MCP-R3: the row is consistent with its pin, but is it the config this adapter was built from? A write card can wait for hours; a row (and its pin) rewritten since the host loaded
    // (grants, or a DB editor who also rewrote the pin) must not be run with the stale in-memory config. Refused without a quarantine: the next host refresh loads the row as it is now.
    const held = configSha256({ imageId: srv.imageId, command: srv.command, env: srv.env, toolClass: srv.cls, depts: srv.depts, snapshotSha256: srv.hash });
    return held === row.approvedConfigSha256 ? null : MCP_TEXT.E_STALE; // a legitimate edit (the pin followed the row): not a quarantine, so the text must not say so
  }
  if (await quarantineConfig({ repo: d.repo, notify: d.notify, ...(d.closeCards ? { closeCards: d.closeCards } : {}), log: d.log }, row)) {
    try { await d.host.refresh(); } catch (err) { d.log.error({ errName: errName(err) }, 'mcp refresh failed'); }
  }
  return MCP_TEXT.E_CONFIG;
}

export function createMcpToolFactory(d: McpToolDeps): (server: HostServer, tool: HostTool) => ToolPlugin<Record<string, unknown>> {
  return (server, tool) => {
    // MC-C8: the host entry seen at precheck is the object run uses (the registry passes the same validated value to both when there is no pin).
    const captured = new WeakMap<object, HostEntry>();
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema,
      untrustedOutput: true,
      untrustedSource: 'mcp',
      kind: server.cls === 'read' ? 'read' : 'write',
      requiresApproval: () => (server.cls === 'read' ? false : { reason: `external tool ${tool.name} (MCP server ${server.slug}, write class)` }),
      async precheck(input: Record<string, unknown>) {
        let on = false;
        try { on = d.enabled() === true; } catch { on = false; }
        if (!on) return { refuse: MCP_TEXT.E_OFF };
        let halted = true;
        try { halted = d.halted(); } catch { halted = true; }
        if (halted) return { refuse: MCP_TEXT.E_HALTED };
        const cur = d.host.entry(tool.name);
        if (!cur || cur.server.hash !== server.hash || cur.server.id !== server.id) return { refuse: MCP_TEXT.E_GONE };
        if (!screenInput(input, d.secrets())) return { refuse: MCP_TEXT.E_INPUT };
        const bad = await configRefusal(d, server);
        if (bad !== null) return { refuse: bad };
        captured.set(input, cur);
        return null;
      },
      async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const e = captured.get(input) ?? d.host.entry(tool.name);
        if (!e) return fail('E_GONE');
        const srv = e.server;
        // 047: a write card can wait for hours, so the pin is checked again here, before the slot, the claim and any container.
        const bad = await configRefusal(d, srv);
        if (bad !== null) return { content: bad, isError: true };
        let slot: { release(): void };
        try { slot = await d.slots.acquire(srv.slug); } catch { return fail('E_BUSY'); }
        try {
          let dayKey: string;
          try { dayKey = dayOf(d.tz(), d.now ? d.now() : new Date()); } catch { return fail('E_CAP_DAY'); }
          const caps = d.caps();
          const actor = actorKey(ctx.actor);
          const taskId = ctx.task?.id ?? null;
          let claim: Awaited<ReturnType<McpToolDeps['repo']['claim']>>;
          try {
            claim = await d.repo.claim({ treeKey: ctx.task?.rootId ?? null, dayKey, slug: srv.slug, treeCap: caps.tree, dayCap: caps.day, serverCap: srv.maxCallsPerDay, actor, tool: e.tool.name, taskId });
          } catch (err) {
            d.log.error({ errName: errName(err) }, 'mcp claim failed');
            return fail('E_INTERNAL');
          }
          if (claim !== 'ok') return fail(CAP[claim]);
          const end = (outcome: string): Promise<void> => d.audit({ actor, action: 'mcp.call.end', tool: e.tool.name, taskId, outcome });
          let out: { changed: true } | { changed: false; text: string; isError: boolean };
          try {
            out = await withSandbox(d.sandbox, { slug: srv.slug, imageId: srv.imageId, command: srv.command, env: srv.env, timeoutMs: srv.timeoutMs }, async (rpc) => {
              await rpc.handshake();
              const live = await rpc.listTools();
              let h: string | null = null;
              try { h = hashRaw(live); } catch { h = null; }
              if (h !== srv.hash) return { changed: true as const };
              const r = await rpc.callTool(e.tool.orig, input, srv.timeoutMs);
              return { changed: false as const, ...processResult(r, d.secrets()) };
            });
          } catch (err) {
            const code: CallCode = err instanceof McpError && err.code in MCP_TEXT ? (err.code as CallCode) : 'E_INTERNAL';
            d.log.error({ errName: errName(err), code }, 'mcp call failed');
            await end(code === 'E_HALTED' ? 'halted' : code);
            return fail(code);
          }
          if (out.changed) {
            // The server's list no longer matches the approved snapshot: tools/call was never written. Quarantine by compare-and-set, drop the tools live, tell #bot-log.
            try {
              const q = await d.repo.quarantine({ id: srv.id, slug: srv.slug, snapshotSha256: srv.hash });
              await d.host.refresh();
              if (q.ok) {
                if (q.expired.length > 0) await d.closeCards?.(q.expired).catch(() => undefined);
                await d.notify(QUARANTINE_NOTICE(srv.slug)).catch(() => undefined);
              }
            } catch (err) {
              d.log.error({ errName: errName(err) }, 'mcp quarantine failed');
            }
            await end('E_CHANGED');
            return fail('E_CHANGED');
          }
          await end(out.isError ? 'tool_error' : 'ok');
          return out.isError ? { content: out.text, isError: true } : { content: out.text };
        } finally {
          slot.release();
        }
      },
    };
  };
}
