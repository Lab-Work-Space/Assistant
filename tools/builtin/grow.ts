import type { ToolIdeaInput as IdeaIn, ToolIdeaService } from '../../grow/tool-ideas.js';
import { ToolIdeaInput } from '../../grow/tool-ideas.js';
import type { ToolRequestInput as RequestIn, ToolRequestService } from '../../grow/tool-requests.js';
import { ToolRequestInput } from '../../grow/tool-requests.js';
import { sameActor, toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../types.js';

export const GROW_TOOL_NAMES = ['tool_request', 'tool_idea'] as const;

const runOf = (ctx: ToolContext) => ({ tainted: ctx.tainted(), task: ctx.task ? { id: ctx.task.id, tainted: ctx.task.tainted } : null, ownsTask: !!ctx.task && sameActor(ctx.task.owner, ctx.actor) });

/**
 * GROW-1: `tool_request` and `tool_idea`. Core builtins granted by prompt meta on the department heads only (both services refuse Praw and personas, and check
 * the halt themselves: the registry refuses on halt only on the approved path). Neither has a `kind` (a kind would raise a central approval card) and
 * `requiresApproval` is false: the only effects are a row and a card or log line. They register through here, not `builtinTools()`, and their names are in
 * builtinNames, so no skill and no `tools.byDept` list can grant them.
 */
export function growTools(svc: { requests: ToolRequestService; ideas: ToolIdeaService }): ToolPlugin<never>[] {
  const request: ToolPlugin<RequestIn> = {
    name: 'tool_request',
    description:
      'Ask the Bot Admins to give your whole department an EXISTING tool you do not have (give its exact name and a short reason). ' +
      'It posts a card; nothing changes until a Bot Admin approves it, and you are told the outcome in this room. At most 3 open requests; refused after you read outside content. ' +
      'Core, sensitive and admin tools cannot be requested. Never say you have the tool before you are told.',
    inputSchema: ToolRequestInput,
    requiresApproval: () => false,
    async run(input, ctx): Promise<ToolResult> {
      const r = await svc.requests.request(ctx.actor, runOf(ctx), input);
      return r.ok ? { content: r.text } : toolError(r.error);
    },
  };
  const idea: ToolPlugin<IdeaIn> = {
    name: 'tool_idea',
    description:
      'File a ticket for a tool that does not exist yet: a short name (lowercase, digits, - or _), the problem it would solve and one example. ' +
      'It only saves a ticket for the Bot Admins to read; nothing is built now. At most 5 open ideas per department.',
    inputSchema: ToolIdeaInput,
    requiresApproval: () => false,
    async run(input, ctx): Promise<ToolResult> {
      const r = await svc.ideas.idea(ctx.actor, runOf(ctx), input);
      return r.ok ? { content: r.text } : toolError(r.error);
    },
  };
  return [request, idea] as unknown as ToolPlugin<never>[];
}
