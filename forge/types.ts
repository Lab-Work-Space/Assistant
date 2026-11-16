/** Leaf types for R7 PLUGIN-FORGE (spec 5.3). No imports: `releases/` may import this file and nothing else of the forge's runtime. */
export type ReleaseStageBy = { kind: 'release'; releaseId: number; decidedBy: string };

/**
 * PF-C9 (overrides spec 5.3): the input has NO class, command, env, timeout or daily field. `stageRelease` hard-codes `write`, `[]`, `{}`, 60000 and 100, and the departments
 * must equal the forge's own department.
 */
export type StageReleaseFn = (input: { slug: string; image: string; departments: string; title: string; ref: string }, by: ReleaseStageBy)
  => Promise<{ ok: true; slug: string; config12: string; toolCount: number } | { ok: false; code: string }>;

export type ForgeEnqueue = (b: { releaseId: number; forgeId: number; pluginSlug: string; sha256: string; bytes: number; manifestSha256: string; decidedBy: string; zip: Buffer })
  => Promise<{ ok: true } | { ok: false; code: 'plugin_invalid' | 'exception' }>;

/** One shipped file as the manifest lists it. */
export interface ShippedFile { path: string; size: number; sha256: string }
export interface PluginInfo {
  forge: { slug: string; title: string; idea: number };
  shipped: ShippedFile[];
  otherCount: number;
  devDeps: { name: string; version: string }[];
  manifestSha256: string;
  /** The shipped entries' bytes, in `shipped` order (the staging step writes exactly these). */
  files: { path: string; data: Buffer }[];
}
export type ValidateResult = { ok: true; info: PluginInfo } | { ok: false; code: string; first?: string };

/**
 * What `ReleaseService` may know of the forge at request and decide time (BE2). Narrow closures built in app.ts over `ForgeRepo` and the config; `releases/` imports nothing of the forge's
 * runtime but this file, `validate.ts` and `unzip.ts`. `enqueue` is the one closure that creates a build row and only the release target deps hold it.
 */
export interface ForgeRequestPort {
  /** `forge.enabled`: read at each use; only exactly `true` is on, a throw is off. */
  enabled(): unknown;
  /** `mcp.enabled`, for the card line only. */
  mcpEnabled(): unknown;
  /** The checked-in base image id (read once at boot), or null when it is unusable. The card shows its first 12 hex. */
  baseId: string | null;
  forgeOf(projectId: number): Promise<{ id: number; status: string; ideaId: number; ideaName: string; deptId: string } | null>;
  capCode(forgeId: number, tz: string): Promise<'forge_attempts' | 'forge_day_cap' | 'image_cap' | null>;
  slugTaken(slug: string, forgeId: number): Promise<boolean>;
  enqueue: ForgeEnqueue;
}

/** `/forge` (spec 5.8): what the slash layer gets, as plain closures (`forgeCommandDeps`). No build, retry, stage, install or GC operation exists here. */
export interface ForgeListItem {
  id: number; ideaId: number; ideaName: string; deptId: string; status: string; projectId: number; serverSlug: string | null;
  lastBuild: { id: number; status: string; code: string | null } | null;
}
export interface ForgeDetail {
  id: number; ideaId: number; ideaName: string; deptId: string; status: string; closeReason: string | null; projectId: number; projectTitle: string; projectStatus: string;
  releases: { id: number; status: string }[];
  builds: { id: number; releaseId: number; status: string; code: string | null; attempts: number; image12: string | null }[];
  server: { slug: string; status: string } | null;
}
export type ForgeCancelResult = { ok: true; serverSlug: string | null; serverStatus: string | null } | { ok: false; code: 'not_found' | 'not_open' | 'busy' | 'exception' };
export interface ForgeCommandDeps {
  list(n: number): Promise<ForgeListItem[]>;
  show(id: number): Promise<ForgeDetail | null>;
  cancel(c: { id: number; userId: string }): Promise<ForgeCancelResult>;
}
