import type { ToolPlugin } from '../types.js';
import { answerSubtask } from './answerSubtask.js';
import { askRequester } from './askRequester.js';
import { createTask } from './createTask.js';
import { forwardTo } from './forwardTo.js';
import { meetingStart } from './meetingStart.js';
import { resolveBlocked } from './resolveBlocked.js';
import { respond } from './respond.js';
import { updateTask } from './updateTask.js';
import { warroomSay } from './warroomSay.js';

export { answerSubtask, askRequester, createTask, forwardTo, meetingStart, resolveBlocked, respond, updateTask, warroomSay };
export { knowledgeTools, KNOWLEDGE_TOOL_NAMES } from './knowledge.js';
export { skillTools, SKILL_TOOL_NAMES } from './skill.js';
export { growTools, GROW_TOOL_NAMES } from './grow.js';
export { projectTools, PROJECT_TOOL_NAMES } from './projects.js';
export { releaseTools, releaseToolDeps, RELEASE_TOOL_NAMES } from './releases.js';

/** The Core v1 built-ins, ready to register. */
export function builtinTools(): ToolPlugin<never>[] {
  return [createTask, updateTask, respond, meetingStart, warroomSay, forwardTo, askRequester, answerSubtask, resolveBlocked] as unknown as ToolPlugin<never>[];
}
