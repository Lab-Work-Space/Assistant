// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// Both modes. own_waive = CLICKUP_WORKSPACE_WRITE_NAMES (a test binds them); clickup_add_comment always gets a card.
import { READ, WRITE, DESTRUCTIVE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('clickup', {
  clickup_list_projects: { ...READ, sensitive: false },
  clickup_search_tasks: { ...READ, sensitive: false },
  clickup_list_open_tasks: { ...READ, sensitive: false },
  clickup_get_task_detail: { ...READ, sensitive: false },
  clickup_list_comments: { ...READ, sensitive: false },
  clickup_list_members: { ...READ, sensitive: false },
  clickup_analyze_project: { ...READ, sensitive: false },
  clickup_create_task: { ...WRITE, sensitive: false, autopilot: 'own_waive' },
  clickup_update_task: { ...WRITE, sensitive: false, autopilot: 'own_waive' },
  clickup_update_status: { ...WRITE, sensitive: false, autopilot: 'own_waive' },
  clickup_assign_task: { ...WRITE, sensitive: false, autopilot: 'own_waive' },
  clickup_add_comment: { ...WRITE, sensitive: false, autopilot: 'always_card' },
  clickup_create_space: { ...WRITE, sensitive: false, autopilot: 'own_waive' },
  clickup_create_folder: { ...WRITE, sensitive: false, autopilot: 'own_waive' },
  clickup_create_list: { ...WRITE, sensitive: false, autopilot: 'own_waive' },
  clickup_delete_task: { ...DESTRUCTIVE, sensitive: false },
});
