// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// music_play, music_skip, music_stop, music_volume: the tree grant may waive the central approval.
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('music', {
  music_play: { ...WRITE, sensitive: false, treeGrant: true },
  music_queue: { ...READ, sensitive: false },
  music_skip: { ...WRITE, sensitive: false, treeGrant: true },
  music_stop: { ...WRITE, sensitive: false, treeGrant: true },
  music_volume: { ...WRITE, sensitive: false, treeGrant: true },
});
