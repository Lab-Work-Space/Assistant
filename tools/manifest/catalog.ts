// R4 PLUGIN-MANIFEST: the catalog of declared tool classes. Imports: types, floor, external, the 17 manifests (and node:crypto for the digest) only; an allowlist test enforces it.
// BE1 is additive: no consumer reads this module yet (BE2 swaps the consumers). The class source is private and frozen at load (PM-C1) and nothing here can set it (PM-C12).
import { createHash } from 'node:crypto';
import { manifest as admin } from '../../admin/manifest.js';
import { manifest as builtin } from '../builtin/manifest.js';
import { manifest as clickup } from '../plugins/clickup/manifest.js';
import { manifest as docs } from '../plugins/docs/manifest.js';
import { manifest as forum } from '../plugins/forum/manifest.js';
import { manifest as github } from '../plugins/github/manifest.js';
import { manifest as lessons } from '../plugins/lessons/manifest.js';
import { manifest as media } from '../plugins/media/manifest.js';
import { manifest as music } from '../plugins/music/manifest.js';
import { manifest as ocr } from '../plugins/ocr/manifest.js';
import { manifest as pin } from '../plugins/pin/manifest.js';
import { manifest as reminders } from '../plugins/reminders/manifest.js';
import { manifest as schedule } from '../plugins/schedule/manifest.js';
import { manifest as watch } from '../plugins/watch/manifest.js';
import { manifest as web } from '../plugins/web/manifest.js';
import { manifest as workspace } from '../plugins/workspace/manifest.js';
import { manifest as ws } from '../plugins/ws/manifest.js';
import { MCP_READ, MCP_WRITE, mcpClassOf } from './external.js';
import { SENSITIVE_TOOL } from './floor.js';
import { FAIL_CLOSED, type ToolClass } from './types.js';

/** Names that start with this belong to external (MCP) tools; the static catalog never declares one (V3). */
export const EXTERNAL_PREFIX = 'mcp_';

export type Manifest = Readonly<Record<string, ToolClass>>;

export interface Derived {
  readonly treeGrant: readonly string[];
  readonly noApproval: readonly string[];
  readonly botTalk: readonly string[];
  readonly ownWaive: readonly string[];
  readonly alwaysCard: readonly string[];
  readonly moneyDoc: readonly string[];
  readonly costOrLasting: readonly string[];
  readonly deptOnly: Readonly<Record<string, string>>;
}

export interface Catalog {
  classOf(name: string): ToolClass;
  /** Every declared name, sorted, frozen. */
  readonly names: readonly string[];
  readonly derived: Derived;
  readonly digest: string;
}

const NAME_OK = /^[a-z][a-z0-9_]{0,63}$/;
const bad = (name: string, rule: string): never => {
  throw new Error(`tool manifest: ${name} ${rule}`);
};

/** V1 to V10 (V5, V6, V7 and V10 include the Gate 1 PM-C5 and PM-C6 clauses). A failure throws, so a boot with a bad manifest is refused. */
function validate(name: string, c: ToolClass, external = false): void {
  if (!NAME_OK.test(name)) bad(name, 'V1: the name must match ^[a-z][a-z0-9_]{0,63}$');
  if (!external && name.startsWith(EXTERNAL_PREFIX)) bad(name, `V3: a name may not start with ${EXTERNAL_PREFIX}`);
  if (!c.sensitive && SENSITIVE_TOOL.test(name)) bad(name, 'V4: sensitive:false is not allowed for a name the floor matches');
  if (c.treeGrant && (c.kind !== 'write' || c.sensitive || c.approval !== 'central' || c.group === 'admin')) bad(name, 'V5: treeGrant needs kind write, not sensitive, approval central and a non-admin group');
  if (c.approval !== 'central' && (c.kind !== 'write' || c.sensitive || c.treeGrant)) bad(name, 'V6: a non-central approval needs kind write, sensitive:false and no treeGrant');
  if (c.autopilot === 'own_waive' && (c.sensitive || c.kind === null)) bad(name, 'V7: own_waive needs a kind and sensitive:false');
  if (c.deptOnly !== null && (typeof c.deptOnly !== 'string' || c.deptOnly === '')) bad(name, 'V8: deptOnly must be null or a non-empty string');
  if (name.startsWith('schedule_') && c.aiReview !== 'cost_or_lasting') bad(name, 'V9: a schedule_ tool needs aiReview cost_or_lasting');
  if (c.group === 'admin' && (c.approval !== 'central' || c.treeGrant || c.autopilot !== 'default' || c.deptOnly !== null || c.aiReview !== 'judge')) bad(name, 'V10: an admin tool keeps every default');
}

const sorted = (xs: string[]): readonly string[] => Object.freeze(xs.sort());

/** Builds an independent, validated, deep-frozen catalog. The module builds exactly one from the real manifests; tests build others to check V1 to V10. */
export function buildCatalog(manifests: readonly Manifest[]): Catalog {
  const map = new Map<string, ToolClass>();
  for (const m of manifests) {
    for (const [name, c] of Object.entries(m)) {
      if (map.has(name)) bad(name, 'V2: declared twice');
      validate(name, c);
      map.set(name, Object.freeze({ ...c }));
    }
  }
  const names = sorted([...map.keys()]);
  const pick = (f: (c: ToolClass) => boolean): readonly string[] => sorted(names.filter((n) => f(map.get(n)!)));
  const deptOnly: Record<string, string> = {};
  for (const n of names) {
    const d = map.get(n)!.deptOnly;
    if (d !== null) deptOnly[n] = d;
  }
  const derived: Derived = Object.freeze({
    treeGrant: pick((c) => c.treeGrant),
    noApproval: pick((c) => c.approval === 'no_approval'),
    botTalk: pick((c) => c.approval === 'bot_talk'),
    ownWaive: pick((c) => c.autopilot === 'own_waive'),
    alwaysCard: pick((c) => c.autopilot === 'always_card'),
    moneyDoc: pick((c) => c.aiReview === 'money_doc'),
    costOrLasting: pick((c) => c.aiReview === 'cost_or_lasting'),
    deptOnly: Object.freeze(deptOnly),
  });
  // R6: the two external profiles pass V1, V4 and V7 here (V3 is skipped for these two names only) and close the canonical array: `@` can never be a tool name (V1).
  validate('mcp_r_aa_x', MCP_READ, true);
  validate('mcp_w_aa_x', MCP_WRITE, true);
  const fields = (c: ToolClass) => ({ aiReview: c.aiReview, approval: c.approval, autopilot: c.autopilot, deptOnly: c.deptOnly, group: c.group, kind: c.kind, sensitive: c.sensitive, treeGrant: c.treeGrant });
  const canonical = JSON.stringify([...names.map((n) => [n, fields(map.get(n)!)]), ['@external', { r: fields(MCP_READ), w: fields(MCP_WRITE) }]]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return Object.freeze({ classOf: (name: string): ToolClass => map.get(name) ?? mcpClassOf(name) ?? FAIL_CLOSED, names, derived, digest });
}

const built = buildCatalog([web, reminders, schedule, watch, lessons, workspace, pin, forum, clickup, github, ocr, music, docs, media, ws, builtin, admin]);

/** The declared class of a name, or FAIL_CLOSED when it is not declared. The returned object is frozen. */
export const classOf = built.classOf;
export const CATALOG_NAMES: readonly string[] = built.names;
export const DERIVED: Derived = built.derived;
/** sha256 (hex) of the canonical catalog, for R5. */
export const CATALOG_DIGEST: string = built.digest;
