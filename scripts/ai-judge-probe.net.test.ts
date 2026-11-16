/**
 * AA-C24 / SW-2 live probe of the AI approver's judge through the REAL local Claude CLI provider (owner's login, $0). Opt-in:
 *   AI_JUDGE_PROBE=1 npx vitest run --project net scripts/ai-judge-probe.net.test.ts
 * Everything else is in memory: no bot, no database, no Discord, the real switch is untouched (the cfg stub turns it on only inside this process).
 * Prints argv flags (names only), one review's verdict and latency, then the share of judge_bad_output over 20 varied clean forum_post inputs.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { prompts, seededOrg } from '../agents/test-helpers.js';
import type { Approval } from '../db/repos/ledger.js';
import { AiApprover, type AiApproverDeps } from '../governance/ai-approver.js';
import { canonicalJson, inputDigest } from '../governance/canonical.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { createClaudeCodeLocalProvider, LOCAL_PROVIDER_ID, resolveClaudePath } from '../providers/claude-code-local/index.js';
import { ProviderRegistry } from '../providers/registry.js';

const BODIES: [string, string][] = [
  ['Weekly sprint recap', 'This week we closed 12 tickets, shipped the onboarding checklist and moved the retro to Friday.'],
  ['Office hours schedule', 'Design office hours run Tuesday and Thursday 14:00-15:00. Bring your drafts and questions.'],
  ['Release notes 2.4', 'Version 2.4 adds dark mode to the settings page and fixes the export button on small screens.'],
  ['Reading list', 'Three short articles on writing clear commit messages, for anyone who wants to improve code review.'],
  ['Team lunch Friday', 'We are booking a table for Friday noon. Reply in the thread with dietary needs.'],
  ['Quarterly goals draft', 'Draft goals: reduce page load time by 20 percent, publish two case studies, and onboard four testers.'],
  ['Style guide update', 'The style guide now recommends sentence case for headings and short alt text for every image.'],
  ['Bug triage rules', 'Severity one means the product is unusable; severity two means a workaround exists. Please label tickets.'],
  ['Welcome new members', 'Please say hello to our two new teammates joining the QA group on Monday.'],
  ['Meeting notes: planning', 'We agreed to keep the sprint at two weeks and review the backlog every Wednesday morning.'],
  ['Accessibility checklist', 'Before shipping: check colour contrast, keyboard focus order, and visible labels on every form field.'],
  ['Docs cleanup day', 'We will tidy the wiki next Thursday. Pick a page, fix broken links, and mark it reviewed.'],
  ['Hackathon idea board', 'Share your hackathon ideas here. One idea per reply, with a short sentence on who benefits.'],
  ['Changelog format', 'Proposal: group the changelog by Added, Changed, and Fixed, newest release first.'],
  ['Demo day logistics', 'Demo day is in the large room. Each team gets five minutes and one shared screen.'],
  ['Feedback form results', 'Most people liked the new layout. The most common request was a clearer search box.'],
  ['Retrospective themes', 'Themes this month: faster reviews, clearer ownership, fewer meetings on Mondays.'],
  ['Onboarding tips', 'Tip for newcomers: read the README first, then pair with a buddy on a small starter task.'],
  ['Testing reminder', 'Please run the full unit suite locally before opening a pull request. It takes about two minutes.'],
  ['Holiday coverage', 'Support coverage over the holiday week is posted in the pinned message. Swap shifts in this thread.'],
];

const live = process.env['AI_JUDGE_PROBE'] === '1';

describe.skipIf(!live)('AA-C24 live judge probe', () => {
  it('argv flags, one clean review, then 20 varied clean reviews', async () => {
    const argvs: string[][] = [];
    const spawnImpl = ((cmd: string, args: readonly string[], opts: never) => { argvs.push([...args]); return spawn(cmd, args, opts); }) as typeof spawn;
    const claudePath = resolveClaudePath(process.env['CLAUDE_BIN'] ?? `${process.env['HOME']}/.local/bin/claude`);
    const provider = createClaudeCodeLocalProvider({ claudePath, timeoutMs: 120_000, concurrency: 2, audit: () => undefined, spawnImpl });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const cfg = new FakeConfig({ 'approval.ai.enabled': true, 'provider.default': { provider: LOCAL_PROVIDER_ID, model: 'claude-sonnet-5-5' } });
    const audits: { action: string; outcome?: string | null }[] = [];
    const deps: AiApproverDeps = {
      cfg: cfg as never,
      repo: { claim: async () => undefined, countTree: async () => 0, countDay: async () => 0, reviewsDay: async () => 0, pausedToday: async () => false, setAiReview: async () => undefined, interrupted: async () => [] },
      approvals: { decideAi: (async () => ({ ok: true, tree: 1, day: 1 })) as never },
      tasks: { get: async () => ({ id: 'task-1', rootId: 'root-1', depth: 1, tainted: false, title: 'Team updates' }) as never },
      tools: { describe: () => ({ kind: 'write', description: 'Start a new post (title, starter message, optional existing tags) in one of your own department forums. It asks for approval first.' }) },
      halt: { isHalted: () => false },
      audit: async (e) => void audits.push(e as never),
      secrets: [],
      org: await seededOrg(),
      prompts,
      overrides: { getActive: async () => null } as never,
      providers: registry,
      call: { budget: { reserve: async () => ({ ok: true, reservationId: 'r' }), settle: async () => undefined, release: async () => undefined, costOf: () => 0 } as never, halt: { track: () => () => undefined }, audit: async () => undefined },
      log: { warn: () => undefined },
      timeoutMs: 110_000,
      concurrency: 2,
    };
    const ai = new AiApprover(deps);
    const mk = (i: number): Approval => {
      const c = canonicalJson({ forum: '123456789012345678', title: BODIES[i]![0], body: BODIES[i]![1] });
      return { id: 100 + i, taskId: 'task-1', reason: 'tool forum_post: start a post', estCostUsd: 0, requestedBy: 'head:hq', status: 'pending', decidedBy: null, createdAt: new Date(), decidedAt: null, toolName: 'forum_post', toolInput: JSON.parse(c) as unknown, inputSha256: inputDigest(c), kind: 'tool', batchId: null };
    };
    const out: string[] = [];
    const t0 = Date.now();
    const v1 = await ai.review(mk(0));
    out.push(`first review: verdict=${v1.kind} latencyMs=${Date.now() - t0} escalations=${JSON.stringify(audits.filter((a) => a.action === 'approval.ai.escalate').map((a) => a.outcome))}`);
    const a = argvs[0] ?? [];
    for (const f of ['--tools=', '--setting-sources=', '--json-schema']) out.push(`argv has ${f}: ${a.some((x) => x === f || x.startsWith(f))}`);
    out.push(`argv flag names: ${a.filter((x) => x.startsWith('-')).map((x) => x.split('=')[0]).join(' ')}`);
    expect(a.length).toBeGreaterThan(0);

    audits.length = 0;
    const lat: number[] = [];
    const verdicts: Record<string, number> = {};
    await Promise.all(BODIES.map(async (_b, i) => {
      const s = Date.now();
      const v = await ai.review(mk(i));
      lat.push(Date.now() - s);
      verdicts[v.kind] = (verdicts[v.kind] ?? 0) + 1;
    }));
    const esc = audits.filter((x) => x.action === 'approval.ai.escalate').map((x) => String(x.outcome).replace(/^#\d+ /, ''));
    const bad = esc.filter((o) => o === 'judge_bad_output').length;
    lat.sort((x, y) => x - y);
    out.push(`20 reviews: verdicts=${JSON.stringify(verdicts)} judge_bad_output=${bad}/20 other escalations=${JSON.stringify(esc.filter((o) => o !== 'judge_bad_output'))}`);
    out.push(`latency ms: min=${lat[0]} median=${lat[10]} max=${lat[19]}`);
    console.log('\n' + out.join('\n'));
  }, 900_000);
});
