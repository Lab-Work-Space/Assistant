import type { SkillProposeInput, SkillService } from '../../skills/service.js';
import { SkillProposeInput as Input } from '../../skills/service.js';
import { toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../types.js';

export const SKILL_TOOL_NAMES = ['skill_propose'] as const;

/**
 * `skill_propose` (SKILLS-1). A core builtin granted by prompt meta on the department heads only; the service refuses everyone but a non-Praw head. It has no
 * tool kind and never asks for approval: its only effect is a proposal row, and nothing reaches a prompt before a Bot Admin confirms the card. The description
 * lives here because prompts/system/tool-use.md is SHA-pinned. There is no `tools` argument: a head cannot propose a tool.
 */
export function skillTools(service: SkillService): ToolPlugin<never>[] {
  const propose: ToolPlugin<SkillProposeInput> = {
    name: 'skill_propose',
    description:
      'Propose a team skill (how your team works: instructions plus up to 3 short templates) for your department or one of its members. ' +
      'op "create" needs a new skill id (lowercase letters, digits and dashes), a title, the instructions and optionally target "dept" or a member id; op "edit" changes a skill your department owns. ' +
      'Give a short reason. It only saves a proposal for a Bot Admin to read and confirm; nothing changes before that. A skill cannot grant tools or change rules, and this is refused after you read outside content.',
    inputSchema: Input,
    requiresApproval: () => false,
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      const r = await service.propose(ctx.actor, { tainted: ctx.tainted(), task: ctx.task ? { id: ctx.task.id, tainted: ctx.task.tainted } : null }, input);
      return r.ok ? { content: r.text } : toolError(r.error);
    },
  };
  return [propose] as unknown as ToolPlugin<never>[];
}
