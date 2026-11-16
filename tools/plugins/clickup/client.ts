import { createHash } from 'node:crypto';
import { HttpError, type HttpClient } from '../../../services/http.js';
import { CLICKUP_ID, InvalidIdError, pathId, vendorId } from '../../../services/ids.js';

/** Fixed vendor base URL (PF9: not user/LLM-influenced, so it uses HttpClient, not net/guard). */
export const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
const MAX_PAGES = 5; // 100 tasks per page
export const TASK_CAP = MAX_PAGES * 100;
const DUE_SOON_MS = 7 * 24 * 3600 * 1000;

export type CuUser = { id: number; username?: string | null; email?: string | null };
export type CuTask = {
  id: string; name: string; status?: { status?: string; type?: string }; assignees?: CuUser[]; due_date?: string | null;
  priority?: { priority?: string } | null; description?: string; url?: string; date_updated?: string; list?: { id?: string; name?: string }; subtasks?: { id: string; name: string }[];
  /** Workspace mode (CLICKUP-ALL-1): the scope check reads these; they are never rendered. */
  space?: { id?: string }; team_id?: string;
};
/** A list as the workspace scope check sees it: ids, names, statuses (the statuses are vendor text: only a read tool with untrustedOutput may show them, C4). */
export type CuListInfo = {
  id: string; name: string; spaceId: string; space: string; folder?: string; statuses: string[];
  /** All-workspaces mode only (CLICKUP-MULTI-1): the owning workspace. The id is never rendered and never logged; the name is vendor text. Absent in numeric and list mode. */
  teamId?: string; teamName?: string;
  /** All-workspaces mode: another workspace of the token has the same normalised name, so a write into this list is refused (CM-C1). */
  teamCollides?: true;
};
/** `workspace` (the workspace name) is set in all-workspaces mode only. */
export type CuHierarchyEntry = { id: string; name: string; space: string; folder?: string; workspace?: string };
export type CuHierarchy = { entries: CuHierarchyEntry[]; spaces: number; truncated: boolean; workspaces?: number };
/** Workspace writes: the client checks scope, re-binds the task's current list to `listId` (C10), then awaits `beforeWrite` (the daily cap, C9) immediately before its one write request. */
export type WriteGuard = { listId: string; /** All-workspaces mode: the pinned workspace label (workspaceLabelText); a mismatch is E_MOVED before the daily take. */ workspace?: string; beforeWrite(): Promise<void> };
/** CLICKUP-HIER-1: a space or folder as the create tools see it (the parent of a folder or list). Ids are never rendered; names are vendor text. */
export type CuParentInfo = {
  kind: 'space' | 'folder'; id: string; name: string; spaceId: string; space: string; folder?: string;
  /** All-workspaces mode only. */
  teamId?: string; teamName?: string; teamCollides?: true;
};
/** CLICKUP-HIER-1: the workspace a new space goes into (numeric mode: the configured one, read fresh). */
export type CuTeamInfo = { teamId: string; teamName: string; teamCollides?: true };
/**
 * CLICKUP-HIER-1 (CH-C1): the guard of a create. Every field the kind requires must be present AND equal to what is true now: an absent or empty one is
 * E_MOVED before `beforeWrite()`, never a skipped check. Space: `workspace` (the label, both modes). Folder and list: `parentId`, `parentPath`, and in all mode `workspace`.
 */
export type HierGuard = { parentId?: string; parentPath?: string; workspace?: string; beforeWrite(): Promise<void> };
export type SearchInput = { query?: string; listId?: string; spaceId?: string; assignee?: string; status?: string; includeDone?: boolean; updatedWithinDays?: number; /** All-workspaces mode: exact workspace name. */ workspace?: string };
export type CuComment = { id: string; comment_text?: string; user?: { id?: number; username?: string }; date?: string };
export type CuProject = { id: string; name: string; folder?: string; space?: string };
export type Analysis = { truncated: boolean; total: number; done: number; donePct: number; byStatus: Record<string, number>; byAssignee: Record<string, number>; overdue: number; dueSoon: number; unassigned: number };

/** The message is fixed text plus a status code; it never carries request config, headers or response bodies (P9). */
export class ClickUpError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'ClickUpError';
  }
}

/** Fixed texts (no vendor strings). */
export const E = {
  TEAM: 'ClickUp: the workspace is not set up (CLICKUP_TEAM_ID is not a workspace this token can see)',
  SCOPE_TASK: 'ClickUp: that task is not in this workspace',
  SCOPE_LIST: 'ClickUp: that list is not in this workspace',
  NEED_LIST: 'ClickUp: name a list by id or exact name (see clickup_list_projects)',
  AMBIG_LIST: 'ClickUp: several lists have that name, use the id',
  MOVED: 'ClickUp: the task or list changed since the card was made; nothing was done',
  BUSY: 'ClickUp: too many requests right now, try again in a minute',
  STATUS: "ClickUp: that status does not exist in the task's list (see clickup_get_task_detail)",
  ASSIGNEE: 'ClickUp: no workspace member has exactly that username or email',
  WORKSPACE_ONLY: 'ClickUp: that call is only available in workspace mode',
  // CLICKUP-MULTI-1 (all-workspaces mode)
  TEAMS: 'ClickUp: no workspace is available (the token sees none or more than 10, or ClickUp cannot be reached)',
  NO_TEAM: 'ClickUp: no workspace this token can see has that name (see clickup_list_projects)',
  AMBIG_TEAM: 'ClickUp: several workspaces have that name, use a list_id or space_id',
  NAME_COLLISION: 'ClickUp: two workspaces this token can see have the same name; rename one in ClickUp before writing',
  // CLICKUP-HIER-1
  DUPLICATE: 'ClickUp: something with that name already exists there; use it (see clickup_list_projects) or choose another name',
  SPACE_CAP: 'ClickUp: that workspace already has 100 spaces, the most the bots can see; nothing was done',
  SCOPE_SPACE: 'ClickUp: that space is not in this workspace',
  SCOPE_FOLDER: 'ClickUp: that folder is not in this workspace',
  CREATE_REFUSED: 'ClickUp refused to create it (plan limit or permission); nothing was created',
  CREATE_UNKNOWN: 'ClickUp did not confirm the create; check clickup_list_projects before trying again',
  LIST_NAME_TRUNCATED: 'ClickUp: too many lists to resolve a name safely, use the list id (clickup_list_projects with a workspace shows it)',
} as const;
export type TeamReason = 'mismatch' | 'unavailable' | 'none' | 'too_many';
/** Carries only a reason code (never an id or vendor text); the app logs and audits the code. */
export class TeamError extends ClickUpError {
  constructor(readonly reason: TeamReason, message: string = E.TEAM) {
    super(message);
    this.name = 'TeamError';
  }
}
/** CM-C3 / CM-C4: what the app audits and announces (counts only: no ids, no names). */
export type TeamsEvent = { kind: 'changed'; before: number; after: number; added: number; removed: number } | { kind: 'too_many'; count: number };
/** The audit action and outcome of a workspace-set event: counts only (CM-C4). */
export const teamsEventAudit = (e: TeamsEvent): { action: string; outcome: string } =>
  e.kind === 'changed' ? { action: 'clickup.teams.changed', outcome: `count:${e.before}->${e.after},+${e.added},-${e.removed}` } : { action: 'clickup.teams.too_many', outcome: `count:${e.count}` };
/** The one #bot-log notice of that event: counts only. */
export const teamsEventNotice = (e: TeamsEvent): string =>
  e.kind === 'changed'
    ? `The ClickUp workspaces this token can see changed: ${e.before} -> ${e.after} (${e.added} added, ${e.removed} removed). Reads and approved writes now reach that set.`
    : `The token sees ${e.count} ClickUp workspaces, more than 10: the last good set stays and the new ones are not read.`;

export type TaskPatch = { name?: string; description?: string; dueDateMs?: number | null; priority?: number | null };

export interface ClickUpClient {
  /** `list`: the one configured list (P9). `workspace` (CLICKUP-ALL-1): every list of the one workspace T, scope = the space ids of T. */
  readonly mode: 'list' | 'workspace';
  /** The one configured list in list mode: create targets it and nothing else (P9). null in workspace mode. */
  readonly listId: string | null;
  /** `one`: list mode and numeric workspace mode. `all` (CLICKUP_TEAM_ID=all): every workspace the token sees, at most 10. */
  readonly teamScope: 'one' | 'all';
  /** Workspace mode: the resolved team id (CLICKUP_TEAM_ID must be among the teams of GET /team). Throws TeamError when unresolved; list mode and all mode throw too (E_WORKSPACE_ONLY in all mode). `teamsReady` (all mode): the number of workspaces in scope, or a TeamError. */
  readonly scope: { team(): Promise<string>; teamsReady(): Promise<number> };
  listProjects(): Promise<CuProject[]>;
  /** Open tasks of the configured list (workspace mode: of `listId`, which must be in scope; closed ones too with `includeDone`). */
  listOpenTasks(o: { includeDone: boolean; listId?: string }): Promise<{ tasks: CuTask[]; truncated: boolean }>;
  getTask(taskId: string): Promise<CuTask>;
  listComments(taskId: string): Promise<CuComment[]>;
  /** The poller's comment read for a task teamTasks returned: in all mode that task was already scope-checked in the same tick, so no second GET /task is made (CM-C8). Otherwise the same as listComments. */
  listCommentsFor(task: CuTask): Promise<CuComment[]>;
  listMembers(o?: { listId?: string }): Promise<CuUser[]>;
  /** Id of the user the API token belongs to (GET /user, cached); null when it cannot be read. */
  currentUserId(): Promise<number | null>;
  analyze(o?: { listId?: string }): Promise<Analysis>;
  /** Writes (Task 26). Every task write refuses a task outside the scope before any write request (P9). Workspace mode: `w` is required. */
  createTask(o: { name: string; description?: string; listId?: string }, w?: WriteGuard): Promise<{ id: string }>;
  updateTask(taskId: string, patch: TaskPatch, w?: WriteGuard): Promise<void>;
  /** `status` is matched case-insensitively against the list's own statuses; an unknown one is an error before any write. */
  updateStatus(taskId: string, status: string, w?: WriteGuard): Promise<string>;
  /** Names are the exact username or email of list members (case-insensitive); each must resolve to exactly one member. */
  assign(taskId: string, o: { add: string[]; remove: string[] }, w?: WriteGuard): Promise<void>;
  addComment(taskId: string, text: string, w?: WriteGuard): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  /** P9 (list mode): whether `project` (a list id, the list's name or 'all'/blank) names the configured list. Anything else is out of scope. */
  inScope(project: string | undefined): Promise<boolean>;

  // ---- workspace mode only (list mode refuses with a fixed text; the tools are not registered there) ----
  /** Space / Folder / List of the workspace (cached 10 min; caps 20 spaces). */
  hierarchy(o?: { workspace?: string }): Promise<CuHierarchy>;
  /** `project` (a list id or an exact list name) -> a list id; empty or 'all' -> E_NEED_LIST; several name matches -> E_AMBIG_LIST. Scope is NOT checked here (see listInScope). */
  resolveList(project: string | undefined): Promise<string>;
  listInScope(listId: string): Promise<CuListInfo>;
  /** The task (scope-checked) and its own list (scope-checked): the statuses and members of a write come from that list, never from a configured one. */
  describeTask(taskId: string): Promise<{ task: CuTask; list: CuListInfo }>;
  /** `searched`: the number of workspaces read, set only by an all-mode search that was not narrowed to one workspace (one page each). */
  searchTasks(o: SearchInput): Promise<{ tasks: CuTask[]; truncated: boolean; searched?: number }>;
  /** The poller's read: open tasks of the watched lists only (re-filtered on our side). `skipped` (all mode): watched lists that are no longer in scope. */
  teamTasks(listIds: readonly string[]): Promise<{ tasks: CuTask[]; truncated: boolean; skipped?: string[] }>;

  // ---- CLICKUP-HIER-1: create space / folder / list (workspace mode only; list mode refuses with E_WORKSPACE_ONLY and the tools are not registered) ----
  /** A space or folder in scope, read fresh. 404, 403, out of scope, archived, hidden and an id mismatch are ONE text per kind (E.SCOPE_SPACE / E.SCOPE_FOLDER, CH-C4). */
  describeParent(kind: 'space' | 'folder', id: string): Promise<CuParentInfo>;
  /** The workspace a new space goes into. All mode: `workspace` is an exact name (E.NO_TEAM / E.AMBIG_TEAM). Numeric mode: the configured workspace, its name read fresh. */
  describeTeam(workspace?: string): Promise<CuTeamInfo>;
  /** A FRESH read of the siblings (bypasses every cache): a sibling with the same name key or displayed key is E.DUPLICATE; 100 or more spaces is E.SPACE_CAP; a read that fails refuses. */
  ensureNew(thing: 'space' | 'folder' | 'list', parent: { kind: 'team' | 'space' | 'folder'; id: string }, name: string): Promise<void>;
  createSpace(o: { name: string; workspace?: string }, g: HierGuard): Promise<{ id: string }>;
  createFolder(o: { spaceId: string; name: string }, g: HierGuard): Promise<{ id: string; spaceId: string }>;
  createList(o: { parent: { kind: 'space' | 'folder'; id: string }; name: string; content?: string }, g: HierGuard): Promise<{ id: string }>;
}

/**
 * CH-C7: the features of every new space. Deep-frozen, never read from config, env or tool input; the POST body is a literal built from it.
 * The toggle values may change after the live check; a new top-level key of the body needs a security review.
 */
const SPACE_DEFAULTS = Object.freeze({
  multiple_assignees: true,
  features: Object.freeze({
    due_dates: Object.freeze({ enabled: true, start_date: false, remap_due_dates: false, remap_closed_due_date: false }),
    time_tracking: Object.freeze({ enabled: false }),
    tags: Object.freeze({ enabled: true }),
    time_estimates: Object.freeze({ enabled: false }),
    checklists: Object.freeze({ enabled: true }),
    custom_fields: Object.freeze({ enabled: true }),
    remap_dependencies: Object.freeze({ enabled: false }),
    dependency_warning: Object.freeze({ enabled: false }),
    portfolios: Object.freeze({ enabled: false }),
  }),
});

const HIDDEN_CTRL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800\u2028\u2029\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** Vendor text for a card line: control, invisible and blank-rendering characters (Default_Ignorable such as the Hangul fillers, Braille blank U+2800) become spaces, `"` and `\` are replaced (so JSON quoting never grows it), whitespace collapsed. */
export const cleanVendorText = (s: string): string => s.replace(HIDDEN_CTRL, ' ').replace(/"/g, "'").replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
/** At most `n` UTF-16 units, cut between code points. */
function clipUnits(s: string, n: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
}
const h6 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 6);
const SEG_MAX = 30;
/**
 * C2: the destination of a write, one deterministic text: `Space / Folder / List [hash]`. Each segment is cut at 30 units, the whole is at most 108
 * units, and the hash covers the FULL names and ids, so a rename beyond the cut still changes it (E_MOVED compares this text, nothing else).
 */
export function listPathText(l: CuListInfo): string {
  const names = [l.space, ...(l.folder ? [l.folder] : []), l.name].map(cleanVendorText);
  const seg = (s: string) => (s.length > SEG_MAX ? `${clipUnits(s, SEG_MAX)}…` : s || '?');
  return `${names.map(seg).join(' / ')} [${h6(`${l.spaceId}\n${l.id}\n${names.join('\n')}`)}]`;
}
/** CM-C1: the key two workspace names are compared by: cleaned, NFKC, case-folded, whitespace collapsed; an empty name is `?`. */
export function workspaceNameKey(name: string): string {
  const c = cleanVendorText(name).replace(/[^\p{ASCII}]/gu, (ch) => CONFUSABLE.get(ch.toLowerCase()) ?? ch).normalize('NFKC').toLowerCase().toUpperCase().toLowerCase().replace(/[^\p{ASCII}]/gu, (ch) => CONFUSABLE.get(ch) ?? ch).replace(/\s+/g, ' ').trim(); // lower-upper-lower: casefold for ß and friends; the map runs before NFKC too (NFKC turns lunate sigma into σ)
  return c || '?';
}
/** G2CM-01: the key of the name as the card DISPLAYS it (cut at 30 units), so two names with the same first 30 units collide. */
export function workspaceDisplayKey(name: string): string {
  return workspaceNameKey(clipUnits(cleanVendorText(name), SEG_MAX));
}
/** G2CM-01: Cyrillic, Greek, Armenian, IPA and small-capital letters that look like Latin ones (lowercase; the key is case-folded first). Fullwidth forms are folded by NFKC. No mixed-script refusal: Thai+Latin names are legitimate. */
const CONFUSABLE: ReadonlyMap<string, string> = new Map(
  ('аa вb еe ёe іi їi јj кk мm нh оo рp сc ѕs тt уy хx ԁd ԛq ԝw һh ӏl үy ԍg ' + 'αa βb γy εe ζz ηn ιi κk μm νv οo ρp τt υu χx ωw ϲc ϳj ' +
    'օo սu ոn հh ցg ' + 'ıi ɑa ɡg ɩi ǀl ƅb ' + 'ᴀa ʙb ᴄc ᴅd ᴇe ɢg ʜh ɪi ᴊj ᴋk ʟl ᴍm ɴn ᴏo ᴘp ʀr ꜱs ᴛt ᴜu ᴠv ᴡw ʏy ᴢz')
    .split(' ').filter(Boolean).map((pair) => [pair.slice(0, 1), pair.slice(1)] as [string, string]),
);
/** CLICKUP-MULTI-1: the workspace of a write as the card shows it: the name cut at 30 units (…) and a hash over the FULL team id and name. At most 40 units. */
export function workspaceLabelText(teamId: string, name: string): string {
  const c = cleanVendorText(name);
  return `${c.length > SEG_MAX ? `${clipUnits(c, SEG_MAX)}…` : c || '?'} [${h6(`${teamId}\n${name}`)}]`;
}
/** CH-C9: whether a text holds a control, invisible or format character (the same set the card cleaning uses). */
export const hasHiddenCtrl = (s: string): boolean => new RegExp(HIDDEN_CTRL.source, 'u').test(s);
/**
 * CLICKUP-HIER-1: the parent of a create as the card shows it, one deterministic text: `Space [hash]` or `Space / Folder [hash]`. Segments are cut at 30 units, at most 74 units
 * in all, and the hash covers the FULL ids and names, so a rename beyond the cut still changes it (E_MOVED compares this text).
 */
export function parentPathText(p: { kind: 'space' | 'folder'; id: string; spaceId: string; space: string; folder?: string }): string {
  const names = [p.space, ...(p.kind === 'folder' ? [p.folder ?? ''] : [])].map(cleanVendorText);
  const seg = (s: string) => (s.length > SEG_MAX ? `${clipUnits(s, SEG_MAX)}…` : s || '?');
  return `${names.map(seg).join(' / ')} [${h6(`${p.kind}\n${p.spaceId}\n${p.id}\n${names.join('\n')}`)}]`;
}
/** C2: the name of an existing task as the card shows it: whole when it is at most 100 units, else cut with a hash of the full name. */
export function taskLabelText(name: string): string {
  const c = cleanVendorText(name) || '?';
  return c.length <= 100 ? c : `${clipUnits(c, 88)}… [${h6(c)}]`;
}

function failure(err: unknown): ClickUpError {
  if (err instanceof ClickUpError) return err;
  if (err instanceof InvalidIdError) return new ClickUpError('ClickUp: invalid task id');
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return new ClickUpError(`ClickUp rejected the credentials (HTTP ${err.status})`, err.status);
    if (err.status === 429) return new ClickUpError('ClickUp rate limit reached, try again later (HTTP 429)', 429);
    if (err.status !== null) return new ClickUpError(`ClickUp request failed (HTTP ${err.status})`, err.status);
    return new ClickUpError(`ClickUp request failed (${err.message})`);
  }
  return new ClickUpError('ClickUp request failed');
}

const BUCKET_PER_MIN = 80; // ClickUp allows 100/min/token; the tools and the poller share this one bucket
const BUCKET_WAIT_MS = 5000;
const PAUSE_429_MS = 60_000;
const SPACES_TTL_MS = 10 * 60_000;
const REFRESH_MIN_MS = 60_000;
const HIER_SPACES = 20;
const HIER_ENTRIES = 1000;
const SEARCH_PAGES = 3;
const POLL_PAGES = 5;
const MAX_SPACES = 100;
const MAX_TEAMS = 10;
const STALE_MAX_MS = 60 * 60_000; // CM-C3: a last good scope is used for at most 60 min after its last success
const TEAM_ID = /^\d{1,20}$/;
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** One token bucket per client (C-3.6): waits at most 5 s for a token, else E_BUSY; a 429 pauses every request for 60 s. */
function createLimiter(now: () => number, sleep: (ms: number) => Promise<void>) {
  let tokens = BUCKET_PER_MIN;
  let last = now();
  let pausedUntil = 0;
  const refill = () => {
    const t = now();
    if (t > last) tokens = Math.min(BUCKET_PER_MIN, tokens + ((t - last) * BUCKET_PER_MIN) / 60_000);
    last = t;
  };
  return {
    pause: () => { pausedUntil = Math.max(pausedUntil, now() + PAUSE_429_MS); },
    async acquire(): Promise<void> {
      const paused = pausedUntil - now();
      if (paused > BUCKET_WAIT_MS) throw new ClickUpError(E.BUSY);
      if (paused > 0) await sleep(paused);
      refill();
      tokens -= 1; // reserved at once, so concurrent callers queue behind each other
      if (tokens >= 0) return;
      const wait = Math.ceil((-tokens * 60_000) / BUCKET_PER_MIN);
      if (wait > BUCKET_WAIT_MS) {
        tokens += 1;
        throw new ClickUpError(E.BUSY);
      }
      await sleep(wait);
    },
  };
}

type Team = { id?: unknown; name?: unknown; members?: { user?: { id?: unknown; username?: unknown; email?: unknown } }[] };
type TeamInfo = { name: string; members: CuUser[] };
/** All-workspaces scope: 𝒯 (teams), SI (space id -> team id), each team's spaces in order, and the teams whose normalised name collides (CM-C1). */
type AllScope = { teams: Map<string, TeamInfo>; si: Map<string, string>; spacesOf: Map<string, [string, string][]>; collide: Set<string> };
const membersOf = (t: Team): CuUser[] => (t.members ?? []).flatMap((m) => (typeof m.user?.id === 'number' ? [{ id: m.user.id, username: typeof m.user.username === 'string' ? m.user.username : null, email: typeof m.user.email === 'string' ? m.user.email : null }] : []));
const byNameThenId = (a: [string, TeamInfo], b: [string, TeamInfo]): number => (a[1].name < b[1].name ? -1 : a[1].name > b[1].name ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

export function createClickUpClient(o: {
  http: HttpClient; token: string; listId?: string | null; teamId?: string | null; /** CLICKUP_TEAM_ID=all: every workspace the token sees (never together with a team id). */ allTeams?: true;
  now?: () => number; sleep?: (ms: number) => Promise<void>; log?: { warn(o: unknown, m?: string): void }; onTeamsEvent?: (e: TeamsEvent) => void;
}): ClickUpClient {
  const now = o.now ?? Date.now;
  // CM-C7 b: the sentinel `all` is never an id; a team id is digits only; the two inputs never come together
  if (o.teamId !== undefined && o.teamId !== null && (o.teamId === 'all' || !TEAM_ID.test(o.teamId))) throw new Error('ClickUp client: the team id must be digits');
  if (o.allTeams && o.teamId) throw new Error('ClickUp client: a team id and all-workspaces mode are exclusive');
  const listId = o.listId ? vendorId(CLICKUP_ID, o.listId) : null;
  const wsTeam = !listId && o.teamId ? vendorId(CLICKUP_ID, o.teamId) : null;
  const all = !listId && o.allTeams === true;
  if (!listId && !wsTeam && !all) throw new Error('ClickUp client: neither a list id nor a team id');
  const workspace = listId === null;
  const log = o.log ?? { warn: () => undefined };
  const emit = (e: TeamsEvent): void => {
    try { o.onTeamsEvent?.(e); } catch { /* a notice that cannot be sent never breaks a read */ }
  };
  const limiter = workspace ? createLimiter(now, o.sleep ?? sleepReal) : null;
  const headers = { authorization: o.token }; // personal token: raw, no "Bearer" (ClickUp docs)
  const guardCall = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      await limiter?.acquire();
      return await f();
    } catch (err) {
      const e = failure(err);
      if (limiter && e.status === 429) limiter.pause();
      throw e;
    }
  };
  const get = async <T>(path: string, query?: [string, string][]): Promise<T> =>
    guardCall(() => o.http.getJson<T>(`${CLICKUP_BASE}${path}`, { headers, ...(query ? { query } : {}) }));
  const send = async (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> =>
    guardCall(() => o.http.sendJson(method, `${CLICKUP_BASE}${path}`, { headers, ...(body === undefined ? {} : { body }) }));
  const wsOnly = (): never => { throw new ClickUpError(E.WORKSPACE_ONLY); };
  const listPath = listId ? `/list/${pathId(CLICKUP_ID, listId)}` : '';

  // ---------------- workspace: team, spaces, scope ----------------
  let team: string | undefined;
  let teamMembers: CuUser[] = [];
  let teamFailedAt = -Infinity;
  let teamFailReason: TeamReason = 'unavailable';
  const resolveTeam = async (): Promise<string> => {
    if (!wsTeam) throw new ClickUpError(E.WORKSPACE_ONLY);
    if (team) return team;
    if (now() - teamFailedAt < REFRESH_MIN_MS) throw new TeamError(teamFailReason); // failure is not cached for good, but retried at most once a minute
    try {
      const r = await get<{ teams?: Team[] }>('/team');
      const hit = (r.teams ?? []).find((t) => t.id === wsTeam);
      if (!hit) {
        teamFailedAt = now();
        teamFailReason = 'mismatch';
        throw new TeamError('mismatch');
      }
      teamMembers = membersOf(hit);
      return (team = wsTeam);
    } catch (err) {
      if (err instanceof TeamError) throw err;
      teamFailedAt = now();
      teamFailReason = 'unavailable';
      throw new TeamError('unavailable');
    }
  };

  let spaces: Map<string, string> | undefined;
  let spacesAt = -Infinity;
  /** CH-C3: set after a create whose outcome may have changed the space list: the cache is read again at the next use (at most once a minute, C6). */
  let spacesStale = false;
  let spacesInflight: Promise<Map<string, string>> | undefined;
  const doLoadSpaces = async (): Promise<Map<string, string>> => {
    const t = await resolveTeam();
    const r = await get<{ spaces?: { id?: unknown; name?: unknown }[] }>(`/team/${pathId(CLICKUP_ID, t)}/space`, [['archived', 'false']]);
    const m = new Map<string, string>();
    for (const s of (r.spaces ?? []).slice(0, MAX_SPACES)) if (typeof s.id === 'string' && CLICKUP_ID.test(s.id)) m.set(s.id, typeof s.name === 'string' ? s.name : '?');
    spaces = m;
    spacesAt = now();
    spacesStale = false;
    return m;
  };
  /** CH-C2: one shared load at a time, so a create can insert its space after the load that was already running. */
  const loadSpaces = (): Promise<Map<string, string>> => {
    spacesInflight ??= doLoadSpaces().finally(() => { spacesInflight = undefined; });
    return spacesInflight;
  };
  const spacesUsable = (): boolean => spaces !== undefined && now() - spacesAt < SPACES_TTL_MS && !(spacesStale && now() - spacesAt >= REFRESH_MIN_MS);
  /** C6: S(T), cached 10 min; a miss may force ONE refresh per 60 s across the process, inside that window it is decided on the cached set. */
  const inSpaces = async (spaceId: unknown): Promise<boolean> => {
    if (typeof spaceId !== 'string') return false;
    let s = spacesUsable() ? spaces! : await loadSpaces();
    if (s.has(spaceId)) return true;
    if (now() - spacesAt >= REFRESH_MIN_MS) s = await loadSpaces();
    return s.has(spaceId);
  };
  const spaceSet = async (): Promise<Map<string, string>> => (spacesUsable() ? spaces! : loadSpaces());

  // ---------------- all workspaces (CLICKUP-MULTI-1): 𝒯, SI, refresh classification ----------------
  let scopeAll: AllScope | undefined;
  let scopeGoodAt = -Infinity; // last refresh in which GET /team and every space GET succeeded (TTL 10 min)
  let scopeAttemptAt = -Infinity; // last refresh attempt (at most one a minute, C6)
  let teamsOkAt = -Infinity; // last successful GET /team (CM-C3: a kept set is used for at most 60 min after it)
  let scopeFail: TeamReason = 'unavailable';
  let lastIds: Set<string> | undefined;
  /** The last good set of workspaces, kept when `scopeAll` is dropped (idle for 60 min, a 401, a long outage): "after a good boot" is judged on this, so a set of 11 can never lock the bots out mid-life (CM-C3 d). A 0-team answer clears it. */
  let lastGoodTeams: Map<string, TeamInfo> | undefined;
  let tooManyAlerted = false;
  let inflight: Promise<AllScope> | undefined;
  const teamSpaces = new Map<string, { m: Map<string, string>; at: number }>(); // each team's own last good spaces
  const teamsErr = (r: TeamReason): TeamError => new TeamError(r, E.TEAMS);

  const doRefresh = async (): Promise<AllScope> => {
    scopeAttemptAt = now();
    let raw: { teams?: Team[] };
    try {
      raw = await get<{ teams?: Team[] }>('/team');
      if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.teams)) throw new ClickUpError(E.TEAMS); // TST-01: a 200 that is not a team list is a transport failure (the last good set stays, CM-C3 a)
    } catch (err) {
      const e = failure(err);
      if (e.status === 401 || e.status === 403) { // authoritative: the token is no longer accepted
        scopeAll = undefined;
        scopeFail = 'unavailable';
        throw teamsErr('unavailable');
      }
      if (scopeAll && now() - teamsOkAt < STALE_MAX_MS) { // transport failure: keep the last good set, at most 60 min
        log.warn({ status: e.status }, 'clickup workspaces refresh failed; the last good set stays');
        return scopeAll;
      }
      scopeAll = undefined;
      scopeFail = 'unavailable';
      throw teamsErr('unavailable');
    }
    const valid = new Map<string, TeamInfo>();
    let dropped = 0;
    for (const t of raw.teams ?? []) {
      if (t === null || typeof t !== 'object') { dropped++; continue; }
      if (typeof t.id !== 'string' || !TEAM_ID.test(t.id)) { dropped++; continue; } // CM-C7 c: never a path segment unless digits
      if (!valid.has(t.id)) valid.set(t.id, { name: typeof t.name === 'string' ? t.name : '?', members: membersOf(t) });
    }
    if (dropped) log.warn({ dropped }, 'clickup workspaces with an unusable id were ignored');
    teamsOkAt = now();
    let next = valid;
    if (valid.size === 0) {
      scopeAll = undefined;
      lastGoodTeams = undefined;
      scopeFail = 'none';
      noteIds(new Set());
      throw teamsErr('none');
    }
    if (valid.size > MAX_TEAMS) {
      const basis = scopeAll?.teams ?? lastGoodTeams;
      if (!basis) { // a boot with no good set ever: more than 10 means off (never a truncated pick)
        scopeFail = 'too_many';
        throw teamsErr('too_many');
      }
      // after a good boot: no widening and no outsider-triggered lockout; teams that left drop out, a new one stays out
      next = new Map([...basis].filter(([id]) => valid.has(id)).map(([id]) => [id, valid.get(id)!]));
      if (!tooManyAlerted) { tooManyAlerted = true; emit({ kind: 'too_many', count: valid.size }); }
      if (next.size === 0) {
        scopeAll = undefined;
        lastGoodTeams = undefined;
        scopeFail = 'none';
        noteIds(new Set());
        throw teamsErr('none');
      }
    } else tooManyAlerted = false;
    lastGoodTeams = next;
    noteIds(new Set(next.keys()));

    const owners = new Map<string, Set<string>>();
    const found = new Map<string, [string, string][]>();
    let allOk = true;
    for (const tid of next.keys()) {
      let m: Map<string, string> | undefined;
      try {
        const r = await get<{ spaces?: { id?: unknown; name?: unknown }[] }>(`/team/${pathId(CLICKUP_ID, tid)}/space`, [['archived', 'false']]);
        m = new Map();
        for (const sp of (r.spaces ?? []).slice(0, MAX_SPACES)) if (typeof sp.id === 'string' && CLICKUP_ID.test(sp.id)) m.set(sp.id, typeof sp.name === 'string' ? sp.name : '?');
        teamSpaces.set(tid, { m, at: now() });
      } catch (err) {
        allOk = false;
        const e = failure(err);
        const last = teamSpaces.get(tid);
        if (e.status !== 401 && e.status !== 403 && last && now() - last.at < STALE_MAX_MS) m = last.m; // its OWN last good spaces, never another team's
        else teamSpaces.delete(tid);
        log.warn({ status: e.status }, 'clickup spaces refresh failed for a workspace');
      }
      if (m) {
        found.set(tid, [...m]);
        for (const sid of m.keys()) owners.set(sid, (owners.get(sid) ?? new Set()).add(tid));
      }
    }
    for (const tid of [...teamSpaces.keys()]) if (!next.has(tid)) teamSpaces.delete(tid);
    const si = new Map<string, string>();
    const spacesOf = new Map<string, [string, string][]>();
    for (const [tid, list] of found) {
      const keep = list.filter(([sid]) => owners.get(sid)!.size === 1); // a space id seen under two teams is dropped (fail closed)
      spacesOf.set(tid, keep);
      for (const [sid] of keep) si.set(sid, tid);
    }
    const collide = new Set<string>();
    for (const keyOf of [workspaceNameKey, workspaceDisplayKey]) { // G2CM-01: the full-name key and the displayed-segment key
      const byKey = new Map<string, string[]>();
      for (const [tid, info] of next) byKey.set(keyOf(info.name), [...(byKey.get(keyOf(info.name)) ?? []), tid]);
      for (const ids of byKey.values()) if (ids.length > 1) for (const id of ids) collide.add(id);
    }
    scopeAll = { teams: next, si, spacesOf, collide };
    if (allOk) scopeGoodAt = now();
    return scopeAll;
  };
  /** CM-C4: a change of the id SET (not the count) is announced with counts only. */
  const noteIds = (ids: Set<string>): void => {
    const before = lastIds;
    lastIds = ids;
    if (!before) return;
    const added = [...ids].filter((x) => !before.has(x)).length;
    const removed = [...before].filter((x) => !ids.has(x)).length;
    if (added || removed) emit({ kind: 'changed', before: before.size, after: ids.size, added, removed });
  };
  const refreshScope = (): Promise<AllScope> => {
    inflight ??= doRefresh().finally(() => { inflight = undefined; });
    return inflight;
  };
  const ensureScope = async (): Promise<AllScope> => {
    if (scopeAll && now() - teamsOkAt >= STALE_MAX_MS) scopeAll = undefined; // too old to trust (rule: stale is not the same as never loaded)
    if (scopeAll && now() - scopeGoodAt < SPACES_TTL_MS) return scopeAll;
    if (inflight) return inflight;
    if (now() - scopeAttemptAt < REFRESH_MIN_MS) {
      if (scopeAll) return scopeAll;
      throw teamsErr(scopeFail);
    }
    return refreshScope();
  };
  /** The workspace that owns `spaceId` (SI). A miss may force ONE refresh a minute across the process (C6: GET /team plus N space GETs, at most 11). */
  const ownerOf = async (spaceId: unknown): Promise<string | undefined> => {
    if (typeof spaceId !== 'string') return undefined;
    let sc = await ensureScope();
    let owner = sc.si.get(spaceId);
    if (owner === undefined && now() - scopeAttemptAt >= REFRESH_MIN_MS) {
      sc = await refreshScope();
      owner = sc.si.get(spaceId);
    }
    return owner;
  };
  /** Exact workspace name (CM-C1 normalisation): none -> E_NO_TEAM, several -> E_AMBIG_TEAM. */
  const teamByName = (sc: AllScope, name: string): string => {
    const k = workspaceNameKey(name);
    const hits = [...sc.teams].filter(([, t]) => workspaceNameKey(t.name) === k);
    if (hits.length === 0) throw new ClickUpError(E.NO_TEAM);
    if (hits.length > 1) throw new ClickUpError(E.AMBIG_TEAM);
    return hits[0]![0];
  };
  const prelude = async (): Promise<void> => {
    if (all) await ensureScope();
    else await resolveTeam();
  };

  const refuse = (what: 'task' | 'list') => new ClickUpError(what === 'task' ? E.SCOPE_TASK : E.SCOPE_LIST);
  const idOf = (raw: string): string => {
    try {
      return pathId(CLICKUP_ID, raw);
    } catch (e) {
      throw failure(e);
    }
  };

  const listInScope = async (raw: string): Promise<CuListInfo> => {
    const id = idOf(raw);
    await prelude();
    let l: { id?: unknown; name?: unknown; folder?: { name?: unknown; hidden?: unknown }; space?: { id?: unknown; name?: unknown }; statuses?: { status?: unknown }[] };
    try {
      l = await get(`/list/${id}`);
    } catch (e) {
      if (e instanceof ClickUpError && (e.status === 404 || e.status === 403)) throw refuse('list');
      throw e;
    }
    // "the fetch succeeded" is not proof of scope: the token may see other workspaces (IDOR)
    const owner = all ? await ownerOf(l.space?.id) : (await inSpaces(l.space?.id)) ? 'one' : undefined;
    if (typeof l.id !== 'string' || l.id !== id || owner === undefined) throw refuse('list');
    const sc = all ? await ensureScope() : undefined;
    return {
      id, name: typeof l.name === 'string' ? l.name : '?', spaceId: l.space!.id as string, space: typeof l.space?.name === 'string' ? l.space.name : '?',
      ...(l.folder && l.folder.hidden !== true && typeof l.folder.name === 'string' ? { folder: l.folder.name } : {}),
      statuses: (l.statuses ?? []).map((s) => s.status).filter((s): s is string => typeof s === 'string'),
      ...(sc ? { teamId: owner, teamName: sc.teams.get(owner)?.name ?? '?', ...(sc.collide.has(owner) ? { teamCollides: true as const } : {}) } : {}),
    };
  };

  const taskScoped = async (raw: string): Promise<{ task: CuTask; owner: string | undefined }> => {
    const id = idOf(raw);
    const t0 = all ? undefined : await resolveTeam();
    if (all) await ensureScope();
    let t: CuTask;
    try {
      t = await get<CuTask>(`/task/${id}`, [['include_subtasks', 'true']]);
    } catch (e) {
      if (e instanceof ClickUpError && (e.status === 404 || e.status === 403)) throw refuse('task');
      throw e;
    }
    // one fixed refusal for "not there", "not yours" and "another workspace": no existence oracle
    if (all) {
      const owner = await ownerOf(t.space?.id); // the owner is SI[space.id]; a task naming another team is refused
      if (owner === undefined || (t.team_id !== undefined && String(t.team_id) !== owner)) throw refuse('task');
      return { task: t, owner };
    }
    if (!(await inSpaces(t.space?.id)) || (t.team_id !== undefined && String(t.team_id) !== t0)) throw refuse('task');
    return { task: t, owner: undefined };
  };
  const taskInScope = async (raw: string): Promise<CuTask> => (await taskScoped(raw)).task;
  const describeTask = async (raw: string): Promise<{ task: CuTask; list: CuListInfo }> => {
    const { task, owner } = await taskScoped(raw);
    const lid = task.list?.id;
    if (typeof lid !== 'string' || !CLICKUP_ID.test(lid)) throw refuse('task');
    let list: CuListInfo;
    try {
      list = await listInScope(lid);
    } catch (e) {
      if (e instanceof ClickUpError && e.message === E.SCOPE_LIST) throw refuse('task');
      throw e;
    }
    if (all && list.teamId !== owner) throw refuse('task'); // the task's list must belong to the task's workspace
    return { task, list };
  };

  const getTask = async (taskId: string): Promise<CuTask> => {
    if (workspace) return taskInScope(taskId);
    let id: string;
    try {
      id = pathId(CLICKUP_ID, taskId);
    } catch (e) {
      throw failure(e);
    }
    // one fixed refusal for "not there", "not yours" and "another list": no existence oracle (P9)
    const refusal = new ClickUpError('ClickUp: that task is not in the configured list');
    let t: CuTask;
    try {
      t = await get<CuTask>(`/task/${id}`, [['include_subtasks', 'true']]);
    } catch (e) {
      if (e instanceof ClickUpError && (e.status === 404 || e.status === 403)) throw refusal;
      throw e;
    }
    if (t.list?.id !== listId) throw refusal;
    return t;
  };

  /** The list a read acts on: list mode = the configured one; workspace = `want` after the scope check. */
  const readList = async (want: string | undefined): Promise<string> => {
    if (!workspace) return listId!;
    if (!want) throw new ClickUpError(E.NEED_LIST);
    return (await listInScope(want)).id;
  };
  const pageOfList = async (lid: string, includeDone: boolean): Promise<{ tasks: CuTask[]; truncated: boolean }> => {
    const out: CuTask[] = [];
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await get<{ tasks?: CuTask[]; last_page?: boolean }>(`/list/${pathId(CLICKUP_ID, lid)}/task`, [
        ['archived', 'false'], ['include_closed', includeDone ? 'true' : 'false'], ['subtasks', 'true'], ['page', String(page)],
      ]);
      out.push(...(r.tasks ?? []));
      if (r.last_page !== false || (r.tasks ?? []).length === 0) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    // C8: re-filtered on our side: a task that names another list is dropped
    return { tasks: out.filter((t) => t.list?.id === undefined || t.list.id === lid), truncated };
  };
  const listOpenTasks = async ({ includeDone, listId: want }: { includeDone: boolean; listId?: string }): Promise<{ tasks: CuTask[]; truncated: boolean }> => {
    if (!workspace) {
      // list mode: byte for byte today's read
      const out: CuTask[] = [];
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await get<{ tasks?: CuTask[]; last_page?: boolean }>(`${listPath}/task`, [
          ['archived', 'false'], ['include_closed', includeDone ? 'true' : 'false'], ['subtasks', 'true'], ['page', String(page)],
        ]);
        out.push(...(r.tasks ?? []));
        if (r.last_page !== false || (r.tasks ?? []).length === 0) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
      // C8: re-filtered on our side (a task that names another list is dropped; one without the field is kept, as before)
      return { tasks: out.filter((t) => t.list?.id === undefined || t.list.id === listId), truncated };
    }
    return pageOfList(await readList(want), includeDone);
  };

  /** Scope check, then the encoded path of a task of the configured list (list mode). */
  const taskPath = async (taskId: string): Promise<string> => {
    await getTask(taskId);
    return `/task/${pathId(CLICKUP_ID, taskId)}`;
  };
  /** All mode, before the daily take: no write into a workspace whose name collides (CM-C1), and the pinned workspace label must be the one true now (the C10 extension, E_MOVED). */
  const allWriteGuard = (list: CuListInfo, w: WriteGuard): void => {
    if (!all) return;
    if (list.teamId === undefined || list.teamName === undefined) throw new ClickUpError(E.MOVED);
    if (list.teamCollides) throw new ClickUpError(E.NAME_COLLISION);
    if (w.workspace === undefined || workspaceLabelText(list.teamId, list.teamName) !== w.workspace) throw new ClickUpError(E.MOVED);
  };
  /** Workspace write prelude (C10): scope, then the task's CURRENT list must equal the pinned one; returns the list for statuses/members. */
  const wsTask = async (taskId: string, w: WriteGuard | undefined): Promise<{ path: string; list: CuListInfo; w: WriteGuard }> => {
    if (!w) throw new ClickUpError(E.WORKSPACE_ONLY);
    const { list } = await describeTask(taskId);
    if (list.id !== w.listId) throw new ClickUpError(E.MOVED);
    allWriteGuard(list, w);
    return { path: `/task/${pathId(CLICKUP_ID, taskId)}`, list, w };
  };
  /** Exact username or email only (case-insensitive): an approved call must name the same person at execution as on the card (P3). */
  const memberId = (members: CuUser[], raw: string): number => {
    const n = raw.trim().toLowerCase();
    const hits = n === '' ? [] : members.filter((m) => (m.username ?? '').toLowerCase() === n || (m.email ?? '').toLowerCase() === n);
    if (hits.length !== 1) throw new ClickUpError(hits.length ? 'ClickUp: that name matches several members, use the email (see clickup_list_members)' : 'ClickUp: no member of the project has exactly that username or email (see clickup_list_members)');
    return hits[0]!.id;
  };

  // ---------------- workspace: hierarchy ----------------
  let hier: CuHierarchy | undefined;
  let hierAt = -Infinity;
  const spaceEntries = async (sid: string, sname: string, workspaceName?: string): Promise<CuHierarchyEntry[]> => {
    const out: CuHierarchyEntry[] = [];
    const ws = workspaceName === undefined ? {} : { workspace: workspaceName };
    const folders = await get<{ folders?: { name?: unknown; lists?: { id?: unknown; name?: unknown }[] }[] }>(`/space/${pathId(CLICKUP_ID, sid)}/folder`, [['archived', 'false']]);
    for (const f of folders.folders ?? []) {
      for (const l of f.lists ?? []) if (typeof l.id === 'string' && CLICKUP_ID.test(l.id)) out.push({ id: l.id, name: typeof l.name === 'string' ? l.name : '?', space: sname, ...(typeof f.name === 'string' ? { folder: f.name } : {}), ...ws });
    }
    const loose = await get<{ lists?: { id?: unknown; name?: unknown }[] }>(`/space/${pathId(CLICKUP_ID, sid)}/list`, [['archived', 'false']]);
    for (const l of loose.lists ?? []) if (typeof l.id === 'string' && CLICKUP_ID.test(l.id)) out.push({ id: l.id, name: typeof l.name === 'string' ? l.name : '?', space: sname, ...ws });
    return out;
  };
  const hierarchyOne = async (): Promise<CuHierarchy> => {
    if (hier && now() - hierAt < SPACES_TTL_MS) return hier;
    const sp = [...(await spaceSet()).entries()];
    const entries: CuHierarchyEntry[] = [];
    let truncated = sp.length > HIER_SPACES;
    for (const [sid, sname] of sp.slice(0, HIER_SPACES)) {
      entries.push(...(await spaceEntries(sid, sname)));
      if (entries.length >= HIER_ENTRIES) { truncated = true; break; }
    }
    hierAt = now();
    return (hier = { entries: entries.slice(0, HIER_ENTRIES), spaces: sp.length, truncated });
  };
  // all mode: one cache per team, filled lazily up to the spaces the global cap of 20 leaves for it (at most 40 GETs per fill, 10 min)
  type TeamHier = { at: number; fetched: number; bySpace: { entries: CuHierarchyEntry[] }[]; truncated: boolean };
  const teamHier = new Map<string, TeamHier>();
  const fillTeam = async (tid: string, name: string, sp: [string, string][], need: number): Promise<TeamHier> => {
    const c = teamHier.get(tid);
    if (c && now() - c.at < SPACES_TTL_MS && c.fetched >= need) return c;
    const bySpace: { entries: CuHierarchyEntry[] }[] = [];
    let n = 0;
    let truncated = false;
    for (const [sid, sname] of sp.slice(0, need)) {
      bySpace.push({ entries: await spaceEntries(sid, sname, name) });
      n++;
      if (bySpace.reduce((a, b) => a + b.entries.length, 0) >= HIER_ENTRIES) { truncated = true; break; }
    }
    const fill: TeamHier = { at: now(), fetched: n, bySpace, truncated };
    teamHier.set(tid, fill);
    return fill;
  };
  const hierarchyAll = async (workspace?: string): Promise<CuHierarchy> => {
    const sc = await ensureScope();
    const only = workspace === undefined ? undefined : teamByName(sc, workspace);
    const teams = only === undefined ? [...sc.teams].sort(byNameThenId) : [[only, sc.teams.get(only)!] as [string, TeamInfo]];
    let remaining = HIER_SPACES; // the cap of 20 spaces is global across the workspaces read here
    let spaces = 0;
    let truncated = false;
    const entries: CuHierarchyEntry[] = [];
    for (const [tid, info] of teams) {
      const sp = sc.spacesOf.get(tid) ?? [];
      if (!sc.spacesOf.has(tid)) truncated = true; // G2CM-02: its space GET failed and it has no last good spaces: unknown, not empty
      spaces += sp.length;
      const take = Math.min(remaining, sp.length);
      if (take < sp.length) truncated = true;
      remaining -= take;
      if (take === 0) continue;
      const fill = await fillTeam(tid, info.name, sp, take);
      if (fill.truncated) truncated = true;
      for (const b of fill.bySpace.slice(0, take)) entries.push(...b.entries);
    }
    if (entries.length > HIER_ENTRIES) truncated = true;
    return { entries: entries.slice(0, HIER_ENTRIES), spaces, truncated, workspaces: teams.length };
  };
  const hierarchy = async (h?: { workspace?: string }): Promise<CuHierarchy> => {
    if (!workspace) return wsOnly();
    if (all) return hierarchyAll(h?.workspace);
    return hierarchyOne();
  };
  const resolveList = async (project: string | undefined): Promise<string> => {
    if (!workspace) return wsOnly();
    const p = (project ?? '').trim();
    if (p === '' || p.toLowerCase() === 'all') throw new ClickUpError(E.NEED_LIST);
    const h = await hierarchy();
    const byId = h.entries.find((e) => e.id === p);
    if (byId) return byId.id;
    const hits = h.entries.filter((e) => e.name.toLowerCase() === p.toLowerCase());
    if (hits.length > 1) throw new ClickUpError(E.AMBIG_LIST);
    // CM-C2: a name is never resolved by guess across a capped hierarchy: the one hit may be a look-alike while the real list lies beyond the cap
    if (all && h.truncated && (hits.length === 1 || !CLICKUP_ID.test(p))) throw new ClickUpError(E.LIST_NAME_TRUNCATED);
    if (hits.length === 1) return hits[0]!.id;
    if (CLICKUP_ID.test(p)) return p; // not in the (capped) hierarchy: listInScope decides
    throw new ClickUpError(E.SCOPE_LIST);
  };

  // ---------------- workspace: create space / folder / list (CLICKUP-HIER-1) ----------------
  const parentRefusal = (kind: 'space' | 'folder') => new ClickUpError(kind === 'space' ? E.SCOPE_SPACE : E.SCOPE_FOLDER);
  /** CH-C4: 404, 403, out of scope, archived, hidden, a space outside the scope and an id mismatch all give the one fixed text of the kind. */
  const describeParent = async (kind: 'space' | 'folder', raw: string): Promise<CuParentInfo> => {
    if (!workspace) return wsOnly();
    let id: string;
    try {
      id = pathId(CLICKUP_ID, raw);
    } catch {
      throw parentRefusal(kind);
    }
    await prelude();
    let r: { id?: unknown; name?: unknown; archived?: unknown; hidden?: unknown; space?: { id?: unknown; name?: unknown } } | null;
    try {
      r = await get(`/${kind}/${id}`);
    } catch (e) {
      if (e instanceof ClickUpError && (e.status === 404 || e.status === 403)) throw parentRefusal(kind);
      throw e;
    }
    if (r === null || typeof r !== 'object' || r.id !== id || r.archived === true || (kind === 'folder' && r.hidden === true)) throw parentRefusal(kind);
    const spaceId = kind === 'space' ? id : r.space?.id;
    if (typeof spaceId !== 'string' || !CLICKUP_ID.test(spaceId)) throw parentRefusal(kind);
    const owner = all ? await ownerOf(spaceId) : (await inSpaces(spaceId)) ? 'one' : undefined;
    if (owner === undefined) throw parentRefusal(kind);
    const nm = typeof r.name === 'string' ? r.name : '?';
    const spaceName = kind === 'space' ? nm : typeof r.space?.name === 'string' ? r.space.name : '?';
    const sc = all ? await ensureScope() : undefined;
    return {
      kind, id, name: nm, spaceId, space: spaceName, ...(kind === 'folder' ? { folder: nm } : {}),
      ...(sc ? { teamId: owner, teamName: sc.teams.get(owner)?.name ?? '?', ...(sc.collide.has(owner) ? { teamCollides: true as const } : {}) } : {}),
    };
  };
  const describeTeam = async (name?: string): Promise<CuTeamInfo> => {
    if (!workspace) return wsOnly();
    if (all) {
      const sc = await ensureScope();
      const tid = teamByName(sc, name ?? '');
      return { teamId: tid, teamName: sc.teams.get(tid)?.name ?? '?', ...(sc.collide.has(tid) ? { teamCollides: true as const } : {}) };
    }
    // CH-C5: the name is read fresh (the cached team id never changes, but the name can)
    const t = await resolveTeam();
    const r = await get<{ teams?: Team[] }>('/team');
    const hit = (r?.teams ?? []).find((x) => x.id === t);
    if (!hit) throw new ClickUpError(E.MOVED);
    return { teamId: t, teamName: typeof hit.name === 'string' ? hit.name : '?' };
  };
  const ensureNew = async (thing: 'space' | 'folder' | 'list', parent: { kind: 'team' | 'space' | 'folder'; id: string }, name: string): Promise<void> => {
    if (!workspace) return wsOnly();
    const pid = pathId(CLICKUP_ID, parent.id);
    const path = parent.kind === 'team' ? `/team/${pid}/space` : parent.kind === 'folder' ? `/folder/${pid}/list` : `/space/${pid}/${thing === 'folder' ? 'folder' : 'list'}`;
    const r = await get<Record<string, unknown> | null>(path, [['archived', 'false']]);
    const rows = r !== null && typeof r === 'object' ? (thing === 'space' ? r['spaces'] : thing === 'folder' ? r['folders'] : r['lists']) : undefined;
    if (!Array.isArray(rows)) throw new ClickUpError('ClickUp returned an unexpected response'); // fail closed
    const k1 = workspaceNameKey(name);
    const k2 = workspaceDisplayKey(name);
    for (const x of rows as { name?: unknown }[]) {
      const n = x !== null && typeof x === 'object' && typeof x.name === 'string' ? x.name : '';
      if (n !== '' && (workspaceNameKey(n) === k1 || workspaceDisplayKey(n) === k2)) throw new ClickUpError(E.DUPLICATE);
    }
    if (thing === 'space' && rows.length >= MAX_SPACES) throw new ClickUpError(E.SPACE_CAP);
  };

  /** An in-process promise chain per parent: a second create under the same parent waits for the first, so its fresh sibling read sees the first one. */
  const tails = new Map<string, Promise<unknown>>();
  const withLock = async <T>(key: string, f: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(f, f);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
  const invalidateHier = (tid?: string): void => {
    hierAt = -Infinity;
    if (tid !== undefined) teamHier.delete(tid);
  };
  /** CH-C3: the POST. A definite 4xx = refused (nothing created); a 429 = busy; anything else that may have created it (timeout, 5xx, network, unparsable, no valid id) = unknown, and the caches are invalidated. */
  const createPost = async (path: string, body: object, invalidate: () => void): Promise<{ id: string; raw: Record<string, unknown> }> => {
    let r: unknown;
    try {
      r = await send('POST', path, body);
    } catch (err) {
      const e = failure(err);
      if (e.message === E.BUSY && e.status === null) throw e; // the limiter refused before any request left
      if (e.status === 429) throw new ClickUpError(E.BUSY, 429);
      if (e.status !== null && e.status >= 400 && e.status < 500 && e.status !== 408) throw new ClickUpError(E.CREATE_REFUSED, e.status);
      invalidate();
      throw new ClickUpError(E.CREATE_UNKNOWN, e.status);
    }
    invalidate();
    const raw = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : {};
    if (typeof raw['id'] !== 'string' || !CLICKUP_ID.test(raw['id'])) throw new ClickUpError(E.CREATE_UNKNOWN);
    return { id: raw['id'], raw };
  };
  /** CH-C2: the new space is inserted AFTER any refresh that was already running, so a stale answer cannot drop it; the next authoritative list decides. */
  const noteCreatedSpace = async (tid: string, sid: string, name: string): Promise<void> => {
    if (all) {
      if (inflight) await inflight.catch(() => undefined);
      const sc = scopeAll;
      if (!sc || !sc.teams.has(tid) || sc.si.get(sid) === tid) return;
      if (sc.si.has(sid) || [...teamSpaces].some(([t, v]) => t !== tid && v.m.has(sid))) { // an id another team also lists is in no team's scope (CH-C2 d): drop it everywhere until the next authoritative list decides
        sc.si.delete(sid);
        for (const [t, l] of sc.spacesOf) sc.spacesOf.set(t, l.filter(([x]) => x !== sid));
        return;
      }
      sc.si.set(sid, tid);
      sc.spacesOf.set(tid, [...(sc.spacesOf.get(tid) ?? []), [sid, name]]);
      const last = teamSpaces.get(tid);
      teamSpaces.set(tid, { m: new Map([...(last?.m ?? []), [sid, name]]), at: last?.at ?? now() });
      scopeGoodAt = -Infinity; // read the list again at the next use (at most once a minute)
      return;
    }
    if (spacesInflight) await spacesInflight.catch(() => undefined);
    if (spaces && !spaces.has(sid)) spaces.set(sid, name);
    spacesStale = true;
  };
  /** CH-C1: every pin this kind requires must be present and equal what is true now. */
  const checkParentPins = (p: CuParentInfo, g: HierGuard): void => {
    if (all && p.teamCollides) throw new ClickUpError(E.NAME_COLLISION);
    if (!g.parentId || g.parentId !== p.id || !g.parentPath || g.parentPath !== parentPathText(p)) throw new ClickUpError(E.MOVED);
    if (all) {
      if (p.teamId === undefined || p.teamName === undefined || !g.workspace || g.workspace !== workspaceLabelText(p.teamId, p.teamName)) throw new ClickUpError(E.MOVED);
    }
  };
  const warnSpace = (kind: 'folder' | 'list', raw: Record<string, unknown>, spaceId: string): void => {
    const sp = raw['space'];
    if (sp !== null && typeof sp === 'object' && (sp as { id?: unknown }).id !== undefined && (sp as { id?: unknown }).id !== spaceId) log.warn({ kind }, 'clickup create: the answer names another space than the parent'); // counts only
  };

  const createSpace = async (o: { name: string; workspace?: string }, g: HierGuard): Promise<{ id: string }> => {
    if (!workspace || !g) return wsOnly();
    const first = await describeTeam(o.workspace);
    return withLock(`team:${first.teamId}`, async () => {
      const t = await describeTeam(o.workspace);
      if (t.teamId !== first.teamId) throw new ClickUpError(E.MOVED);
      if (all && t.teamCollides) throw new ClickUpError(E.NAME_COLLISION);
      if (!g.workspace || g.workspace !== workspaceLabelText(t.teamId, t.teamName)) throw new ClickUpError(E.MOVED);
      await ensureNew('space', { kind: 'team', id: t.teamId }, o.name);
      await g.beforeWrite();
      const body = { name: o.name, multiple_assignees: SPACE_DEFAULTS.multiple_assignees, features: SPACE_DEFAULTS.features };
      const made = await createPost(`/team/${pathId(CLICKUP_ID, t.teamId)}/space`, body, () => { invalidateHier(t.teamId); spacesStale = true; if (all) scopeGoodAt = -Infinity; });
      await noteCreatedSpace(t.teamId, made.id, o.name);
      return { id: made.id };
    });
  };
  const createFolder = async (o: { spaceId: string; name: string }, g: HierGuard): Promise<{ id: string; spaceId: string }> => {
    if (!workspace || !g) return wsOnly();
    return withLock(`space:${o.spaceId}`, async () => {
      const p = await describeParent('space', o.spaceId);
      checkParentPins(p, g);
      await ensureNew('folder', { kind: 'space', id: p.id }, o.name);
      await g.beforeWrite();
      const made = await createPost(`/space/${pathId(CLICKUP_ID, p.id)}/folder`, { name: o.name }, () => invalidateHier(p.teamId));
      warnSpace('folder', made.raw, p.id);
      return { id: made.id, spaceId: p.id };
    });
  };
  const createList = async (o: { parent: { kind: 'space' | 'folder'; id: string }; name: string; content?: string }, g: HierGuard): Promise<{ id: string }> => {
    if (!workspace || !g) return wsOnly();
    return withLock(`${o.parent.kind}:${o.parent.id}`, async () => {
      const p = await describeParent(o.parent.kind, o.parent.id);
      checkParentPins(p, g);
      await ensureNew('list', { kind: p.kind, id: p.id }, o.name);
      await g.beforeWrite();
      const body = { name: o.name, ...(o.content ? { content: o.content } : {}) };
      const made = await createPost(`/${p.kind}/${pathId(CLICKUP_ID, p.id)}/list`, body, () => invalidateHier(p.teamId));
      warnSpace('list', made.raw, p.spaceId);
      return { id: made.id };
    });
  };

  // ---------------- workspace: search and poll ----------------
  const teamTaskPages = async (query: [string, string][], pages: number, keep: (t: CuTask) => boolean): Promise<{ tasks: CuTask[]; truncated: boolean }> => {
    const t = await resolveTeam();
    const s = await spaceSet();
    const out: CuTask[] = [];
    let truncated = false;
    for (let page = 0; page < pages; page++) {
      const r = await get<{ tasks?: CuTask[]; last_page?: boolean }>(`/team/${pathId(CLICKUP_ID, t)}/task`, [...query, ['page', String(page)]]);
      // C8: the server-side filters are not trusted: space in S(T) and the caller's own filter are applied again here
      out.push(...(r.tasks ?? []).filter((x) => typeof x.space?.id === 'string' && s.has(x.space.id) && (x.team_id === undefined || String(x.team_id) === t) && keep(x)));
      if (r.last_page !== false || (r.tasks ?? []).length === 0) break;
      if (page === pages - 1) truncated = true;
    }
    return { tasks: out, truncated };
  };
  /** All mode: the same read for ONE workspace; the C8 re-filter checks SI[space.id] equals the queried team. */
  const polled = new WeakSet<CuTask>(); // tasks teamTasks returned: scope-checked in the same tick (CM-C8)
  const teamTaskPagesFor = async (tid: string, query: [string, string][], pages: number, keep: (t: CuTask) => boolean, mark = false): Promise<{ tasks: CuTask[]; truncated: boolean }> => {
    const out: CuTask[] = [];
    let truncated = false;
    for (let page = 0; page < pages; page++) {
      const r = await get<{ tasks?: CuTask[]; last_page?: boolean }>(`/team/${pathId(CLICKUP_ID, tid)}/task`, [...query, ['page', String(page)]]);
      const si = (await ensureScope()).si;
      const ok = (r.tasks ?? []).filter((x) => typeof x.space?.id === 'string' && si.get(x.space.id) === tid && (x.team_id === undefined || String(x.team_id) === tid) && keep(x));
      if (mark) for (const x of ok) polled.add(x);
      out.push(...ok);
      if (r.last_page !== false || (r.tasks ?? []).length === 0) break;
      if (page === pages - 1) truncated = true;
    }
    return { tasks: out, truncated };
  };
  const members = async (): Promise<CuUser[]> => {
    await resolveTeam();
    return teamMembers;
  };
  const searchAll = async (i: SearchInput): Promise<{ tasks: CuTask[]; truncated: boolean; searched?: number }> => {
    const sc = await ensureScope();
    const q: [string, string][] = [['order_by', 'updated'], ['subtasks', 'true'], ['include_closed', i.includeDone === true ? 'true' : 'false']];
    let wantList: string | undefined;
    let wantSpace: string | undefined;
    const picks: string[] = []; // the workspace each narrowing names; they must agree
    if (i.listId) {
      const l = await listInScope(i.listId);
      wantList = l.id;
      picks.push(l.teamId!);
      q.push(['list_ids[]', wantList]);
    }
    if (i.spaceId) {
      const sid = idOf(i.spaceId);
      const owner = await ownerOf(sid);
      if (owner === undefined) throw refuse('list');
      wantSpace = sid;
      picks.push(owner);
      q.push(['space_ids[]', sid]);
    }
    if (i.workspace !== undefined) picks.push(teamByName(sc, i.workspace));
    if (new Set(picks).size > 1) throw new ClickUpError(E.SCOPE_LIST);
    const narrowed = picks[0];
    const teams = narrowed === undefined ? [...sc.teams].sort(byNameThenId).map(([id]) => id) : [narrowed];
    if (i.assignee) {
      const n = i.assignee.trim().toLowerCase();
      const seen = new Map<number, CuUser>(); // the members of the workspaces searched, one entry per user id
      for (const tid of teams) for (const m of sc.teams.get(tid)?.members ?? []) seen.set(m.id, m);
      const hit = n === '' ? [] : [...seen.values()].filter((m) => (m.username ?? '').toLowerCase() === n || (m.email ?? '').toLowerCase() === n);
      if (hit.length !== 1) throw new ClickUpError(E.ASSIGNEE);
      q.push(['assignees[]', String(hit[0]!.id)]);
    }
    if (i.status) q.push(['statuses[]', i.status]);
    if (i.updatedWithinDays) q.push(['date_updated_gt', String(now() - i.updatedWithinDays * 86_400_000)]);
    const needle = (i.query ?? '').trim().toLowerCase();
    const keep = (x: CuTask) => (!wantList || x.list?.id === wantList) && (!wantSpace || x.space?.id === wantSpace) && (!needle || x.name.toLowerCase().includes(needle));
    const tasks: CuTask[] = [];
    let truncated = false;
    for (const tid of teams) {
      const r = await teamTaskPagesFor(tid, q, narrowed === undefined ? 1 : SEARCH_PAGES, keep); // no workspace named: the first page of each (at most 10 requests)
      tasks.push(...r.tasks);
      truncated ||= r.truncated;
    }
    const upd = (t: CuTask) => Number(t.date_updated ?? 0) || 0;
    tasks.sort((a, b) => upd(b) - upd(a));
    return { tasks, truncated, ...(narrowed === undefined ? { searched: teams.length } : {}) };
  };
  const searchTasks = async (i: SearchInput): Promise<{ tasks: CuTask[]; truncated: boolean; searched?: number }> => {
    if (!workspace) return wsOnly();
    if (all) return searchAll(i);
    const q: [string, string][] = [['order_by', 'updated'], ['subtasks', 'true'], ['include_closed', i.includeDone === true ? 'true' : 'false']];
    let wantList: string | undefined;
    let wantSpace: string | undefined;
    if (i.listId) { wantList = (await listInScope(i.listId)).id; q.push(['list_ids[]', wantList]); }
    if (i.spaceId) {
      const sid = idOf(i.spaceId);
      if (!(await inSpaces(sid))) throw refuse('list');
      wantSpace = sid;
      q.push(['space_ids[]', sid]);
    }
    if (i.assignee) {
      const n = i.assignee.trim().toLowerCase();
      const hit = n === '' ? [] : (await members()).filter((m) => (m.username ?? '').toLowerCase() === n || (m.email ?? '').toLowerCase() === n);
      if (hit.length !== 1) throw new ClickUpError(E.ASSIGNEE);
      q.push(['assignees[]', String(hit[0]!.id)]);
    }
    if (i.status) q.push(['statuses[]', i.status]);
    if (i.updatedWithinDays) q.push(['date_updated_gt', String(now() - i.updatedWithinDays * 86_400_000)]);
    const needle = (i.query ?? '').trim().toLowerCase(); // the API has no text search: a substring on the name, on our side
    return teamTaskPages(q, SEARCH_PAGES, (x) => (!wantList || x.list?.id === wantList) && (!wantSpace || x.space?.id === wantSpace) && (!needle || x.name.toLowerCase().includes(needle)));
  };
  const listTeam = new Map<string, { teamId: string; at: number }>(); // list -> workspace, filled by listInScope (10 min)
  const teamTasks = async (ids: readonly string[]): Promise<{ tasks: CuTask[]; truncated: boolean; skipped?: string[] }> => {
    if (!workspace) return wsOnly();
    const want = new Set(ids.map((x) => vendorId(CLICKUP_ID, x)));
    if (want.size === 0) return { tasks: [], truncated: false, ...(all ? { skipped: [] } : {}) };
    const q: [string, string][] = [['include_closed', 'false'], ['subtasks', 'true'], ...[...want].map((x): [string, string] => ['list_ids[]', x])];
    if (!all) return teamTaskPages(q, POLL_PAGES, (x) => typeof x.list?.id === 'string' && want.has(x.list.id));
    const sc = await ensureScope();
    const skipped: string[] = [];
    const byTeam = new Map<string, Set<string>>();
    for (const id of want) {
      let c = listTeam.get(id);
      if (!c || now() - c.at >= SPACES_TTL_MS || !sc.teams.has(c.teamId)) {
        try {
          c = { teamId: (await listInScope(id)).teamId!, at: now() };
          listTeam.set(id, c);
        } catch (e) {
          if (e instanceof ClickUpError && e.message === E.SCOPE_LIST) { // out of scope now: skipped, never read (a transport failure throws and the tick backs off)
            listTeam.delete(id);
            skipped.push(id);
            continue;
          }
          throw e;
        }
      }
      byTeam.set(c.teamId, (byTeam.get(c.teamId) ?? new Set()).add(id));
    }
    const k = byTeam.size;
    const pages = Math.min(POLL_PAGES, Math.max(1, Math.floor(10 / Math.max(1, k)))); // at most about 10 page requests a tick
    const tasks: CuTask[] = [];
    let truncated = false;
    for (const tid of [...byTeam.keys()].sort()) {
      const lists = byTeam.get(tid)!;
      const r = await teamTaskPagesFor(tid, [['include_closed', 'false'], ['subtasks', 'true'], ...[...lists].map((x): [string, string] => ['list_ids[]', x])], pages, (x) => typeof x.list?.id === 'string' && lists.has(x.list.id), true);
      tasks.push(...r.tasks);
      truncated ||= r.truncated;
    }
    return { tasks, truncated, skipped };
  };

  const listComments = async (taskId: string): Promise<CuComment[]> => {
    await getTask(taskId); // scope check first: comments of a task outside the scope are never fetched
    return (await get<{ comments?: CuComment[] }>(`/task/${pathId(CLICKUP_ID, taskId)}/comment`)).comments ?? [];
  };

  let me: number | null | undefined;
  return {
    mode: workspace ? 'workspace' : 'list',
    listId,
    teamScope: all ? 'all' : 'one',
    scope: {
      team: resolveTeam,
      async teamsReady() {
        if (all) return (await ensureScope()).teams.size;
        await resolveTeam();
        return 1;
      },
    },
    async currentUserId() {
      if (me !== undefined) return me;
      try {
        const id = (await get<{ user?: { id?: unknown } }>('/user')).user?.id;
        return (me = typeof id === 'number' ? id : null);
      } catch {
        return null; // not cached: tried again next time
      }
    },
    async createTask(t, w) {
      let path = `${listPath}/task`;
      if (workspace) {
        if (!w || !t.listId) throw new ClickUpError(E.WORKSPACE_ONLY);
        const l = await listInScope(t.listId);
        if (l.id !== w.listId) throw new ClickUpError(E.MOVED);
        allWriteGuard(l, w);
        await w.beforeWrite();
        path = `/list/${pathId(CLICKUP_ID, l.id)}/task`;
      }
      const r = (await send('POST', path, { name: t.name, ...(t.description ? { description: t.description } : {}) })) as { id?: unknown } | null;
      if (typeof r?.id !== 'string' || !CLICKUP_ID.test(r.id)) throw new ClickUpError('ClickUp returned an unexpected response');
      return { id: r.id };
    },
    async updateTask(taskId, p, w) {
      let path: string;
      if (workspace) {
        const x = await wsTask(taskId, w);
        path = x.path;
        await x.w.beforeWrite();
      } else path = await taskPath(taskId);
      const body: Record<string, unknown> = {};
      if (p.name !== undefined) body['name'] = p.name;
      if (p.description !== undefined) body['description'] = p.description;
      if (p.dueDateMs !== undefined) Object.assign(body, p.dueDateMs === null ? { due_date: null } : { due_date: p.dueDateMs, due_date_time: false });
      if (p.priority !== undefined) body['priority'] = p.priority;
      await send('PUT', path, body);
    },
    async updateStatus(taskId, status, w) {
      if (workspace) {
        const x = await wsTask(taskId, w);
        const want = status.trim().toLowerCase();
        const hit = x.list.statuses.find((n) => n.toLowerCase() === want);
        if (!hit) throw new ClickUpError(E.STATUS); // C4: fixed text, no vendor status name
        await x.w.beforeWrite();
        await send('PUT', x.path, { status: hit });
        return hit;
      }
      const path = await taskPath(taskId);
      const l = await get<{ statuses?: { status?: string }[] }>(listPath);
      const names = (l.statuses ?? []).map((s) => s.status).filter((s): s is string => typeof s === 'string');
      const want = status.trim().toLowerCase();
      const hit = names.find((n) => n.toLowerCase() === want);
      if (!hit) throw new ClickUpError(`ClickUp: unknown status. Valid statuses of this project: ${names.join(', ') || 'none'}`);
      await send('PUT', path, { status: hit });
      return hit;
    },
    async assign(taskId, a, w) {
      if (workspace) {
        const x = await wsTask(taskId, w);
        const ms = (await get<{ members?: CuUser[] }>(`/list/${pathId(CLICKUP_ID, x.list.id)}/member`)).members ?? [];
        const add = a.add.map((n) => memberId(ms, n));
        const rem = a.remove.map((n) => memberId(ms, n));
        await x.w.beforeWrite();
        await send('PUT', x.path, { assignees: { add, rem } });
        return;
      }
      const path = await taskPath(taskId);
      const ms = (await get<{ members?: CuUser[] }>(`${listPath}/member`)).members ?? [];
      const add = a.add.map((n) => memberId(ms, n));
      const rem = a.remove.map((n) => memberId(ms, n));
      await send('PUT', path, { assignees: { add, rem } });
    },
    async addComment(taskId, text, w) {
      if (workspace) {
        const x = await wsTask(taskId, w);
        await x.w.beforeWrite();
        await send('POST', `${x.path}/comment`, { comment_text: text, notify_all: false });
        return;
      }
      await send('POST', `${await taskPath(taskId)}/comment`, { comment_text: text, notify_all: false });
    },
    async deleteTask(taskId) {
      if (workspace) return wsOnly(); // C: delete is not available in workspace mode
      await send('DELETE', await taskPath(taskId));
    },
    async listProjects() {
      if (workspace) return (await hierarchy()).entries.map((e) => ({ id: e.id, name: e.name, ...(e.folder ? { folder: e.folder } : {}), space: e.space }));
      const l = await get<{ id: string; name: string; folder?: { name?: string; hidden?: boolean }; space?: { name?: string } }>(listPath);
      return [{ id: String(l.id), name: l.name, ...(l.folder && !l.folder.hidden && l.folder.name ? { folder: l.folder.name } : {}), ...(l.space?.name ? { space: l.space.name } : {}) }];
    },
    listOpenTasks,
    getTask,
    listComments,
    async listCommentsFor(task) {
      if (all && polled.has(task) && CLICKUP_ID.test(task.id)) return (await get<{ comments?: CuComment[] }>(`/task/${pathId(CLICKUP_ID, task.id)}/comment`)).comments ?? [];
      return listComments(task.id);
    },
    async listMembers(m) {
      const lid = await readList(m?.listId);
      return (await get<{ members?: CuUser[] }>(`/list/${pathId(CLICKUP_ID, lid)}/member`)).members ?? [];
    },
    async analyze(m) {
      const { tasks, truncated } = await listOpenTasks({ includeDone: true, ...(m?.listId ? { listId: m.listId } : {}) });
      const t0 = now();
      const a: Analysis = { truncated, total: tasks.length, done: 0, donePct: 0, byStatus: Object.create(null), byAssignee: Object.create(null), overdue: 0, dueSoon: 0, unassigned: 0 };
      for (const t of tasks) {
        const sn = t.status?.status ?? 'unknown';
        a.byStatus[sn] = (a.byStatus[sn] ?? 0) + 1;
        const isDone = t.status?.type === 'closed' || t.status?.type === 'done';
        if (isDone) a.done++;
        if (!t.assignees?.length) a.unassigned++;
        for (const u of t.assignees ?? []) { const n = u.username ?? '?'; a.byAssignee[n] = (a.byAssignee[n] ?? 0) + 1; }
        const due = t.due_date ? Number(t.due_date) : NaN;
        if (!isDone && Number.isFinite(due)) {
          if (due < t0) a.overdue++;
          else if (due < t0 + DUE_SOON_MS) a.dueSoon++;
        }
      }
      a.donePct = a.total ? Math.round((a.done / a.total) * 100) : 0;
      return a;
    },
    async inScope(project) {
      if (workspace) return wsOnly();
      const p = (project ?? '').trim();
      if (p === '' || p.toLowerCase() === 'all' || p === listId) return true;
      if (/^\d+$/.test(p)) return false; // another list id: refused without a request
      const [l] = await this.listProjects();
      return l!.name.toLowerCase() === p.toLowerCase();
    },
    hierarchy,
    resolveList,
    listInScope: (id) => (workspace ? listInScope(id) : wsOnly()),
    describeTask: (id) => (workspace ? describeTask(id) : wsOnly()),
    searchTasks,
    teamTasks,
    describeParent,
    describeTeam,
    ensureNew,
    createSpace,
    createFolder,
    createList,
  };
}
