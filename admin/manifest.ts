// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// The 11 ADMIN_TOOL_NAMES: kindless, all default, sensitive per SENSITIVE_TOOL (discord_read is the one non-sensitive name, skill-grant.test.ts:47).
import { NOKIND, defineManifest } from '../tools/manifest/types.js';

export const manifest = defineManifest('admin', {
  config_get: { ...NOKIND, sensitive: true },
  config_propose: { ...NOKIND, sensitive: true },
  admin_op_propose: { ...NOKIND, sensitive: true },
  discord_read: { ...NOKIND, sensitive: false },
  perm_propose: { ...NOKIND, sensitive: true },
  server_propose: { ...NOKIND, sensitive: true },
  deploy_propose: { ...NOKIND, sensitive: true },
  deploy_read: { ...NOKIND, sensitive: true },
  site_publish_static: { ...NOKIND, sensitive: true },
  code_propose: { ...NOKIND, sensitive: true },
  code_rollback: { ...NOKIND, sensitive: true },
});
