// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// meeting_start: cost. forward_to: tree grant. warroom_say: bot talk. knowledge_, prompt_, skill_ tools are sensitive.
// release_request: kindless, software only (RL-C7); always_card / cost_or_lasting are inert labels for it, the guarantee is structural (RL-C1, RL-C2).
import { NOKIND, WRITE, defineManifest } from '../manifest/types.js';

export const manifest = defineManifest('builtin', {
  create_task: { ...NOKIND, sensitive: false },
  respond: { ...NOKIND, sensitive: false },
  update_task: { ...NOKIND, sensitive: false },
  answer_subtask: { ...NOKIND, sensitive: false },
  ask_requester: { ...NOKIND, sensitive: false },
  resolve_blocked: { ...NOKIND, sensitive: false },
  meeting_start: { ...NOKIND, sensitive: false, aiReview: 'cost_or_lasting' },
  forward_to: { ...WRITE, sensitive: false, treeGrant: true },
  warroom_say: { ...WRITE, sensitive: false, approval: 'bot_talk' },
  kb_search: { ...NOKIND, sensitive: false },
  knowledge_propose: { ...NOKIND, sensitive: true },
  prompt_propose: { ...NOKIND, sensitive: true },
  skill_propose: { ...NOKIND, sensitive: true },
  project_propose: { ...NOKIND, sensitive: false },
  project_task: { ...NOKIND, sensitive: false },
  tool_request: { ...NOKIND, sensitive: false },
  tool_idea: { ...NOKIND, sensitive: false },
  release_request: { ...NOKIND, sensitive: false, deptOnly: 'software', autopilot: 'always_card', aiReview: 'cost_or_lasting' },
});
