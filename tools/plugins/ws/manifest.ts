// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// All ws_ tools are software-only (DEPT_ONLY). The five writes skip approval (WS-C18).
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('ws', {
  ws_create: { ...WRITE, sensitive: false, approval: 'no_approval', deptOnly: 'software' },
  ws_list: { ...READ, sensitive: false, deptOnly: 'software' },
  ws_read: { ...READ, sensitive: false, deptOnly: 'software' },
  ws_write: { ...WRITE, sensitive: false, approval: 'no_approval', deptOnly: 'software' },
  ws_delete: { ...WRITE, sensitive: false, approval: 'no_approval', deptOnly: 'software' },
  ws_run: { ...WRITE, sensitive: false, approval: 'no_approval', deptOnly: 'software' },
  ws_export: { ...WRITE, sensitive: false, approval: 'no_approval', deptOnly: 'software' },
});
