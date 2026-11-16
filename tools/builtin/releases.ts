import { z } from 'zod';
import type { ReleaseService } from '../../releases/service.js';
import { SLUG_RE } from '../../workspaces/files.js';
import { sameActor, toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../types.js';

export const RELEASE_TOOL_NAMES = ['release_request'] as const;

export const ReleaseRequestInput = z.object({
  slug: z.string().regex(SLUG_RE),
  title: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(600),
  target: z.enum(['handoff', 'install_plugin']).optional(),
}).strict();
export type ReleaseRequestInput = z.infer<typeof ReleaseRequestInput>;

type Request = ReleaseService['request'];
/** What the tool is handed (RL-C1c): a closure over `request` and nothing else. */
export type ReleaseToolDeps = { releases: { request: Request } };

/**
 * RL-C1(c): app.ts passes `releaseToolDeps(releaseService)`, never the service. A `Pick<>` is erased at run time and the whole service (decide, claim,
 * reject) would stay reachable from a tool; this object has exactly one own property and no prototype methods.
 */
export function releaseToolDeps(service: { request: Request }): ReleaseToolDeps {
  return { releases: { request: (actor, run, input) => service.request(actor, run, input) } };
}

const EXCEPTION_TEXT = 'That could not be done now; nothing was changed.';

/**
 * R5 RELEASE-1: `release_request`. A core builtin granted by the software head's prompt meta and limited to software by the manifest (RL-C7); the service
 * refuses every other actor. NO `kind` and `requiresApproval` is false: the tool only files a row and a Bot Admin card, so it never creates an `approvals`
 * row and no autopilot or AI approver is consulted (RL-C2). The manifest class (always card, cost or lasting) is an inert label here, not a guard: the
 * guarantee is the structural boundary (RL-C1) plus the test that a call creates no approvals row. It registers through here, not `builtinTools()`.
 */
export function releaseTools(svc: ReleaseToolDeps): ToolPlugin<never>[] {
  const request: ToolPlugin<ReleaseRequestInput> = {
    name: 'release_request',
    description:
      'Ask a Bot Admin to release a finished deliverable from a project workspace: give the workspace slug, a short title and a summary (at most 600 characters). ' +
      'Code zips the workspace now, pins those exact bytes, attaches the last recorded ws_run results and posts one card in #setting. ' +
      'Nothing is released until a Bot Admin approves; then the zip is posted in this task thread. Only inside a task you own. Never say it is released before you are told. Use target install_plugin inside a forge project to have code build and stage an MCP plugin from the workspace (a Bot Admin still installs it).',
    inputSchema: ReleaseRequestInput,
    requiresApproval: () => false,
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      try {
        const r = await svc.releases.request(ctx.actor, {
          tainted: ctx.tainted(),
          task: ctx.task ? { id: ctx.task.id, rootId: ctx.task.rootId, tainted: ctx.task.tainted } : null,
          ownsTask: !!ctx.task && sameActor(ctx.task.owner, ctx.actor),
          source: ctx.source,
        }, input);
        return r.ok ? { content: r.text } : toolError(r.error);
      } catch {
        return toolError(EXCEPTION_TEXT); // the service never throws; a fault here carries no text on purpose
      }
    },
  };
  return [request] as unknown as ToolPlugin<never>[];
}
