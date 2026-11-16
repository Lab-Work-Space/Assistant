// R4 PM-C2 (ii): records the OLD decision paths for a list of names. It imports only the pre-swap consumer modules, NEVER the catalog:
// the names come in as a parameter, so the recorded values can not be derived from the manifest. The committed file is
// tools/__golden__/decision-matrix.json; BE2 must keep it byte-equal (only the three probe names may change `nonSensitive`, `routable` and `eligible`).
import { ADMIN_TOOL_NAMES } from '../../admin/names.js';
import { ApprovalRooms, isNonSensitiveTool } from '../../discord/approval/approval-rooms.js';
import { approvalBatchHooks } from '../../discord/commands/approval.js';
import { canonicalJson, inputDigest } from '../../governance/canonical.js';
import { COST_OR_LASTING_PREFIX, COST_OR_LASTING_TOOLS, MONEY_DOC_TOOLS, precheckCall } from '../../governance/ai-approver.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { realRegistry } from '../autopilot.golden.harness.js';
import { AUTOPILOT_ALWAYS_CARD, AUTOPILOT_OWN_WAIVE } from '../autopilot.js';
import { GROW_TOOL_NAMES, KNOWLEDGE_TOOL_NAMES, PROJECT_TOOL_NAMES, RELEASE_TOOL_NAMES, SKILL_TOOL_NAMES, builtinTools } from '../builtin/index.js';
import { createToolPolicy } from '../policy.js';
import { approvalFor, isBotTalk, isNoApproval, type ToolKind } from '../policy-approval.js';
import { skillToolAllowed } from '../skill-grant.js';
import { treeGrantCovers, treeGrantEligible } from '../tree-grant-scope.js';
import { TREE_GRANT_TOOLS } from '../tree-grant-tools.js';

/** Probe names that are NOT registered anywhere: they record how an unknown name behaves today. */
export const PROBE_NAMES = ['mcp_r_probe_x', 'mcp_w_probe_x', 'mcp_x', 'stub_write', 'zz_unknown'] as const;

/**
 * Tools the real registry harness does not build (docs/media/ocr/clickup list mode need external services) plus the admin registry.
 * kind = the declared kind at the anchor (a test reads the source file to check it). `undefined` kind = the tool declares none.
 */
export const NOT_IN_REAL: Readonly<Record<string, { file: string; kind: ToolKind | undefined }>> = {
  diagram_create: { file: 'tools/plugins/docs/index.ts', kind: 'write' },
  video_generate: { file: 'tools/plugins/media/index.ts', kind: 'write' },
  sheets_append_receipt: { file: 'tools/plugins/ocr/sheets.ts', kind: 'write' },
  clickup_delete_task: { file: 'tools/plugins/clickup/write.ts', kind: 'destructive' },
  ...Object.fromEntries(ADMIN_TOOL_NAMES.map((n) => [n, { file: 'admin/tools.ts', kind: undefined }])),
};

export type Row = Record<string, unknown>;
const flag = (v: false | { reason: string }): 'free' | 'ask' => (v === false ? 'free' : 'ask');

export async function recordMatrix(names: readonly string[]): Promise<Record<string, Row>> {
  const real = await realRegistry();
  const realNames = new Set(real.names());
  const builtinNames = [...builtinTools().map((t) => t.name), ...KNOWLEDGE_TOOL_NAMES, ...SKILL_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...RELEASE_TOOL_NAMES, ...GROW_TOOL_NAMES];
  const kindUsed = (n: string): ToolKind | undefined => (realNames.has(n) ? real.kindOf(n) : NOT_IN_REAL[n]?.kind);
  const known = (n: string): boolean => realNames.has(n) || n in NOT_IN_REAL;
  const registered = [...realNames, ...Object.keys(NOT_IN_REAL).filter((n) => NOT_IN_REAL[n]!.file !== 'admin/tools.ts')];
  const skillEnv = { registered: () => registered, builtins: () => builtinNames, kindOf: kindUsed };
  const describeReal = (n: string): { kind?: string } | undefined => (!known(n) ? undefined : { kind: kindUsed(n) as string });
  const rooms = new ApprovalRooms({
    cfg: new FakeConfig({ 'approvals.channelByCategory': {} }) as never, tasks: { get: async () => null }, port: {} as never, org: { heads: () => [] }, botUserIds: () => new Map(), adminRoleId: 'a', alert: async () => undefined, log: { error() {} },
  });
  const hooks = approvalBatchHooks({ port: {} as never, rooms, secrets: [] });
  const out: Record<string, Row> = {};
  for (const n of [...names].sort()) {
    const kind = known(n) ? kindUsed(n) : undefined;
    const approval = { id: 1, taskId: 't1', reason: 'r', estCostUsd: 0, requestedBy: 'head:praw', status: 'pending', decidedBy: null, createdAt: new Date(0), decidedAt: null, toolName: n, toolInput: { url: 'https://example.com' }, inputSha256: 'a'.repeat(64), kind: 'tool' } as never;
    const ctx = (direct: boolean, t: boolean) => ({ direct, tainted: () => t });
    const s = { tool: n, target: 't', change: 'c' };
    const pol = (dept: string, prompt: string[]) => createToolPolicy({ get: ((k: string) => (k === 'tools.byDept' ? { software: [n] } : undefined)) as never }, () => [n], () => [], () => 'write').effective(dept, prompt);
    const treeRow = { kind: 'tool', toolName: n, toolInput: {}, inputSha256: inputDigest(canonicalJson({})) };
    const probe = !known(n);
    const row: Row = {
      alwaysCard: AUTOPILOT_ALWAYS_CARD.includes(n),
      approvalFor: kind === undefined ? null : { delegatedClean: flag(approvalFor(kind, ctx(false, false), s)), delegatedTainted: flag(approvalFor(kind, ctx(false, true), s)), directClean: flag(approvalFor(kind, ctx(true, false), s)), directTainted: flag(approvalFor(kind, ctx(true, true), s)) },
      botTalk: isBotTalk(n),
      costOrLasting: COST_OR_LASTING_TOOLS.includes(n) || n.startsWith(COST_OR_LASTING_PREFIX),
      effectivePraw: pol('praw', ['*']).includes(n),
      effectiveSoftware: pol('software', []).includes(n),
      eligible: hooks.eligible(approval),
      kind: kind ?? null,
      moneyDoc: MONEY_DOC_TOOLS.includes(n),
      noApproval: isNoApproval(n),
      nonSensitive: isNonSensitiveTool(n),
      ownWaive: AUTOPILOT_OWN_WAIVE.includes(n),
      precheckAsWrite: probe ? 'n/a' : (precheckCall(n, {}, () => ({ kind: 'write' })) ?? 'ok'),
      precheckReal: precheckCall(n, {}, describeReal) ?? 'ok',
      registeredReal: realNames.has(n),
      routable: rooms.routable(approval),
      skillAsWrite: probe ? null : skillToolAllowed(n, { registered: () => [n], builtins: () => [], kindOf: () => 'write' }),
      skillReal: skillToolAllowed(n, skillEnv),
      treeEligible: treeGrantEligible(treeRow, kindUsed),
      treeGrant: TREE_GRANT_TOOLS.includes(n),
      treeGrantCovers: treeGrantCovers(n, kind, false),
    };
    out[n] = Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return out;
}

export const serializeMatrix = (m: Record<string, Row>): string => JSON.stringify(m, null, 2) + '\n';
