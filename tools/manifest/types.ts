// R4 PLUGIN-MANIFEST (GROWTH-1): the shape of a tool's declared class. A leaf module: NO imports (an allowlist test enforces it).

/** null = the tool has no kind (most builtins, all admin tools). Must equal `ToolPlugin.kind ?? null`. */
export type DeclKind = 'read' | 'write' | 'destructive' | null;

export interface ToolClass {
  /** The plugin folder name (= the factory id), or 'builtin' / 'admin'. */
  readonly group: string;
  readonly kind: DeclKind;
  /** REQUIRED in every entry (no preset supplies it). `false` is a grant: it is reviewed membership (privileged.json `sensitiveFalse`). */
  readonly sensitive: boolean;
  readonly approval: 'central' | 'no_approval' | 'bot_talk';
  readonly deptOnly: string | null;
  readonly treeGrant: boolean;
  readonly autopilot: 'default' | 'own_waive' | 'always_card';
  readonly aiReview: 'judge' | 'money_doc' | 'cost_or_lasting';
}

export type ManifestEntry = Omit<ToolClass, 'group'>;
export type Preset = Omit<ManifestEntry, 'sensitive'>;

const preset = (kind: DeclKind): Preset => Object.freeze({ kind, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'default', aiReview: 'judge' } as const);

/** Presets = exactly today's behaviour for a name absent from every policy list. */
export const READ: Preset = preset('read');
export const WRITE: Preset = preset('write');
export const DESTRUCTIVE: Preset = preset('destructive');
export const NOKIND: Preset = preset(null);

/** Stamps the group on every entry and freezes the result (entries hold only primitives, so one level is deep). */
export function defineManifest(group: string, m: Readonly<Record<string, ManifestEntry>>): Readonly<Record<string, ToolClass>> {
  const out: Record<string, ToolClass> = {};
  for (const [name, e] of Object.entries(m)) out[name] = Object.freeze({ group, kind: e.kind, sensitive: e.sensitive, approval: e.approval, deptOnly: e.deptOnly, treeGrant: e.treeGrant, autopilot: e.autopilot, aiReview: e.aiReview });
  return Object.freeze(out);
}

/** What `classOf` answers for a name that is not declared: sensitive, always a card, hard-denied by the AI reviewer. Frozen. */
export const FAIL_CLOSED: ToolClass = Object.freeze({ group: '', kind: null, sensitive: true, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'always_card', aiReview: 'cost_or_lasting' } as const);
