// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// fetch_page and web_search: autopilot may waive their own approval reason (privileged.json ownWaive).
import { READ, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('web', {
  fetch_page: { ...READ, sensitive: false, autopilot: 'own_waive' },
  web_search: { ...READ, sensitive: false, autopilot: 'own_waive' },
});
