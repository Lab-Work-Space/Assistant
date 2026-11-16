import { randomUUID } from 'node:crypto';
import { Org, SEED_DEPARTMENTS, SEED_PERSONAS, type ActorRef, type IncomingMessage, type OrgRepos } from '../company/index.js';
import { EventBus, type AppEvents } from '../core/events.js';
import type { Department, Persona } from '../db/repos/org.js';
import { newRunState } from '../tools/types.js';
import { defaultTainted, ParentCancelledError, type NewTask, type Task, type TaskPatch, type TaskRepo, type TaskStatus } from '../db/repos/tasks.js';
import { redactText } from '../core/logger.js';
import type { AuditEntry } from '../governance/audit.js';
import { PROMPTS_DIR, loadPrompts, type PromptDoc } from '../prompts/index.js';
import type { NoteAdd, NoteSource } from '../db/repos/ledger.js';
import { ROOM_BODY_MAX, ROOM_RETAIN, type NewRoomEntry, type RoomEntry, type RoomEntryStore, type RoomKind } from '../db/repos/room-entries.js';

export const quiet = { error: () => undefined };
export const prompts: Map<string, PromptDoc> = loadPrompts(PROMPTS_DIR);

/** Real Org over the seed rows; `edit` tweaks rows (e.g. disable a dept) before loading. */
export async function seededOrg(
  opts: { prompts?: Map<string, PromptDoc>; /** channel id -> dept id, as /channel map would store it */ mapped?: Record<string, string>; editDept?: (d: Department) => Department; editPersona?: (p: Persona) => Persona } = {},
): Promise<Org> {
  const docs = opts.prompts ?? prompts;
  const depts: Department[] = SEED_DEPARTMENTS.map((d) => ({ ...d, model: null, provider: null, enabled: true })).map(opts.editDept ?? ((d) => d));
  const personas: Persona[] = Object.entries(SEED_PERSONAS)
    .map(([id, p]) => {
      const ref = `members/${id}`;
      return {
        id, deptId: p.dept, name: docs.get(ref)!.meta.name, avatarUrl: null, promptRef: ref, model: null, provider: null,
        tools: docs.get(ref)!.meta.tools, directChannelId: p.directChannelId, enabled: true,
      };
    })
    .map(opts.editPersona ?? ((p) => p));
  const repos = {
    departments: { list: async () => depts },
    personas: { list: async () => personas },
    channelMap: { list: async () => Object.entries(opts.mapped ?? {}).map(([channelId, deptId]) => ({ channelId, deptId, isWork: false })) },
  } as unknown as OrgRepos;
  return Org.load(repos, docs);
}

/** Prompt docs where one member's meta also allows create_task (to reach the canDelegate guard). */
export function promptsWithTool(ref: string, tool: string): Map<string, PromptDoc> {
  const copy = new Map(prompts);
  const d = copy.get(ref)!;
  copy.set(ref, { ...d, meta: { ...d.meta, tools: [...d.meta.tools, tool] } });
  return copy;
}

/** In-memory TaskRepo with the same root/depth and optimistic-update semantics as the SQL repo. */
export class MemTasks implements Pick<TaskRepo, 'createUnderOpenParent' | 'rerouteExists' | 'recentRerouteOpen' | 'countOpenRerouteRoots' | 'claimOffdayNotice' | 'takeForward' | 'setWarroomSay' | 'claimWarroomSay' | 'findOpenConversation' | 'findByThread' | 'create' | 'get' | 'update' | 'countChildren' | 'countOpen' | 'countOpenChildren' | 'listByStatus' | 'lastEndedChild' | 'setResultMessage' | 'openOwnedBy'> {
  /** Update order, standing in for updated_at. */
  private readonly touched = new Map<string, number>();
  private tick = 0;
  async lastEndedChild(parentId: string): Promise<Task | null> {
    const ended = [...this.rows.values()].filter((t) => t.parentId === parentId && (t.status === 'done' || t.status === 'cancelled'));
    ended.sort((a, b) => (this.touched.get(b.id) ?? 0) - (this.touched.get(a.id) ?? 0));
    return ended[0] ? { ...ended[0] } : null;
  }
  async listByStatus(s: TaskStatus): Promise<Task[]> {
    return [...this.rows.values()].filter((t) => t.status === s).map((t) => ({ ...t }));
  }
  readonly rows = new Map<string, Task>();
  /** TASKADMIN-1: the stored blocked notes by task id (TaskRepo keeps them in a column that `Task` does not carry). */
  readonly notes = new Map<string, string>();
  async create(t: NewTask): Promise<Task> {
    const id = t.id ?? randomUUID();
    const parent = t.parentId ? this.rows.get(t.parentId) : undefined;
    if (t.parentId && !parent) throw new Error(`parent task ${t.parentId} not found`);
    if (parent?.status === 'cancelled') throw new ParentCancelledError(); // TA-C8, as TaskRepo
    const row: Task = {
      id, title: t.title, description: t.description ?? '', deptId: t.deptId, owner: t.owner, requester: t.requester,
      parentId: t.parentId ?? null, rootId: parent ? parent.rootId : id, depth: t.depth ?? (parent ? parent.depth + 1 : 0),
      status: t.status ?? 'todo', threadId: t.threadId ?? null, turnsUsed: 0, costUsd: 0, estCostUsd: t.estCostUsd ?? null, blockedReason: null,
      origin: t.origin, channelId: t.channelId ?? null, sourceUserId: t.sourceUserId ?? null,
      tainted: t.tainted ?? defaultTainted(t.origin),
      originCategoryId: parent ? parent.originCategoryId ?? null : t.originCategoryId ?? null,
      conversation: t.conversation ?? false, originMessageId: t.originMessageId ?? null, warroomSayId: null,
      ...(t.forwardCard ? { forwardCard: t.forwardCard } : {}),
      acceptance: t.acceptance ?? null, dueOn: t.dueOn ?? null, handoffMessageId: null, resultMessageId: null,
      ...(t.rerouteSourceId ? { rerouteSourceId: t.rerouteSourceId, rerouteWhere: t.rerouteWhere ?? null } : {}),
    };
    // REROUTE-1: the same unique index as the SQL repo (tasks_reroute_once)
    if (t.rerouteSourceId && [...this.rows.values()].some((x) => x.rerouteSourceId === t.rerouteSourceId && x.deptId === t.deptId)) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "tasks_reroute_once"'), { code: '23505', constraint: 'tasks_reroute_once' });
    }
    this.rows.set(id, row);
    this.touched.set(id, ++this.tick);
    this.createdAt.set(id, this.clock());
    return { ...row };
  }
  /** REROUTE-1: creation times (the SQL repo's created_at) for the duplicate guard; `clock` is a test seam. */
  readonly createdAt = new Map<string, number>();
  clock: () => number = Date.now;
  async createUnderOpenParent(t: NewTask & { parentId: string }): Promise<Task | null> {
    const p = this.rows.get(t.parentId);
    if (!p || (p.status !== 'doing' && p.status !== 'review')) return null;
    return this.create(t);
  }
  async rerouteExists(messageId: string, deptId: string): Promise<boolean> {
    return [...this.rows.values()].some((x) => x.rerouteSourceId === messageId && x.deptId === deptId);
  }
  async recentRerouteOpen(a: { deptId: string; requester: Task['requester']; where: string; parentId?: string | null; since: Date }): Promise<boolean> {
    const same = (x: Task['requester']) => JSON.stringify(x) === JSON.stringify(a.requester);
    return [...this.rows.values()].some((x) => x.deptId === a.deptId && x.status !== 'done' && x.status !== 'cancelled' && (this.createdAt.get(x.id) ?? 0) >= a.since.getTime() &&
      ((!!x.rerouteSourceId && x.rerouteWhere === a.where && same(x.requester)) || (!!a.parentId && x.parentId === a.parentId)));
  }
  async countOpenRerouteRoots(userId: string): Promise<number> {
    return [...this.rows.values()].filter((x) => !!x.rerouteSourceId && !x.parentId && x.requester.kind === 'human' && x.requester.userId === userId && x.status !== 'done' && x.status !== 'cancelled').length;
  }
  async get(id: string): Promise<Task | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async update(id: string, patch: TaskPatch, expected?: TaskStatus): Promise<Task | null> {
    const r = this.rows.get(id);
    if (!r || (expected && r.status !== expected)) return null;
    const { blockedNote, ...rest } = patch;
    const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (patch.status !== undefined && patch.blockedReason === undefined) r.blockedReason = null; // same rule as TaskRepo (R35)
    // TASKADMIN-1: the note lives beside the row, never on it (TA-C15); cleared like TaskRepo does
    if (blockedNote !== undefined) this.notes.set(id, redactText(blockedNote).replace(/\s+/g, ' ').trim().slice(0, 300));
    else if (patch.status !== undefined || patch.blockedReason !== undefined) this.notes.delete(id);
    Object.assign(r, clean);
    this.touched.set(id, ++this.tick);
    return { ...r };
  }
  /** TASKADMIN-1: the /task done digest over id, status, the update tick and the open-children count. */
  async acceptDigest(id: string): Promise<string | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    const open = [...this.rows.values()].filter((t) => t.parentId === id && t.status !== 'done' && t.status !== 'cancelled').length;
    return `${r.id.slice(0, 8)}${r.status.slice(0, 2)}${this.touched.get(id) ?? 0}${open}`.slice(0, 12).padEnd(12, '0');
  }
  async setResultMessage(id: string, messageId: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || !/^[0-9]{17,20}$/.test(messageId)) return false;
    r.resultMessageId = messageId;
    return true;
  }
  async openOwnedBy(personaId: string, limit: number): Promise<Task[]> {
    return [...this.rows.values()].filter((t) => t.owner.kind === 'persona' && t.owner.personaId === personaId && t.status !== 'done' && t.status !== 'cancelled')
      .sort((a, b) => (this.touched.get(b.id) ?? 0) - (this.touched.get(a.id) ?? 0)).slice(0, Math.max(1, limit)).map((t) => ({ ...t }));
  }
  readonly offdayNotices = new Map<string, string>();
  async claimOffdayNotice(rootId: string, day: string): Promise<boolean> {
    if (this.offdayNotices.get(rootId) === day) return false;
    this.offdayNotices.set(rootId, day);
    return true;
  }
  readonly forwardsTaken = new Map<string, number>();
  async takeForward(rootId: string, cap: number): Promise<boolean> {
    const n = this.forwardsTaken.get(rootId) ?? 0;
    if (n >= cap) return false;
    this.forwardsTaken.set(rootId, n + 1);
    return true;
  }
  async setWarroomSay(id: string, messageId: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.warroomSayId || !/^[0-9]{17,20}$/.test(messageId)) return false;
    r.warroomSayId = messageId;
    return true;
  }
  async claimWarroomSay(id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r?.warroomSayId) return false;
    r.warroomSayId = null;
    return true;
  }
  async findOpenConversation(a: { deptId: string; userId: string; where: string }): Promise<Task | null> {
    const t = [...this.rows.values()].find((x) => x.conversation && x.deptId === a.deptId && x.threadId === a.where && x.requester.kind === 'human' && x.requester.userId === a.userId && x.status !== 'done' && x.status !== 'cancelled');
    return t ? { ...t } : null;
  }
  async findByThread(threadId: string): Promise<Task | null> {
    const t = [...this.rows.values()].find((x) => x.threadId === threadId);
    return t ? { ...t } : null;
  }
  async countChildren(parentId: string): Promise<number> {
    return [...this.rows.values()].filter((t) => t.parentId === parentId).length;
  }
  async countOpenChildren(parentId: string): Promise<number> {
    return [...this.rows.values()].filter((t) => t.parentId === parentId && t.status !== 'done' && t.status !== 'cancelled').length;
  }
  async countOpen(): Promise<number> {
    return [...this.rows.values()].filter((t) => t.status !== 'done' && t.status !== 'cancelled').length;
  }
}

export class MemNotes {
  readonly rows: { deptId: string; taskId: string | null; body: string; tainted: boolean; source: NoteSource; pinned: boolean }[] = [];
  async add(deptId: string, taskId: string | null, body: string, o: { tainted?: boolean; source?: NoteSource; pinned?: boolean; max?: number } = {}): Promise<NoteAdd> {
    if (o.max !== undefined && body.length > o.max) return 'refused'; // the real repo screens the length too
    this.rows.push({ deptId, taskId, body, tainted: o.tainted ?? true, source: o.source ?? 'task', pinned: o.pinned ?? false });
    return 'added';
  }
  private shape(deptId: string) {
    return this.rows.map((n, i) => ({ ...n, id: i + 1 })).filter((n) => n.deptId === deptId).map((n) => ({ id: n.id, deptId: n.deptId, taskId: n.taskId, body: n.body, pinned: n.pinned, tainted: n.tainted, source: n.source, createdAt: new Date(0) }));
  }
  async latest(deptId: string, limit: number) {
    return this.shape(deptId).reverse().slice(0, limit);
  }
  async forContext(deptId: string, recent: number) {
    const all = this.shape(deptId);
    return [...all.filter((n) => n.pinned).slice(-10), ...all.filter((n) => !n.pinned).slice(-recent)].sort((a, b) => a.id - b.id);
  }
  async reflectedToday(deptId: string): Promise<number> {
    return this.rows.filter((n) => n.deptId === deptId && n.source === 'reflect').length;
  }
}

export function auditSpy(): { entries: AuditEntry[]; audit: (e: AuditEntry) => Promise<void> } {
  const entries: AuditEntry[] = [];
  return { entries, audit: async (e) => void entries.push(e) };
}

export const newBus = () => new EventBus<AppEvents>(quiet);

export const CTO: ActorRef = { kind: 'head', dept: 'software' };
export const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };

export function humanMsg(content: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: randomUUID(), channelId: '1565682159375749161', parentChannelId: null, threadId: null,
    author: { id: '42', name: 'owner', kind: 'human' }, content, mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat', ...over,
  };
}

/** The R3 fields of a ToolContext for tests that build one by hand: a plain, untainted, non-direct delegated run. */
export function runCtxBase(over: { origin?: Task['origin'] } = {}) {
  const run = newRunState();
  return {
    origin: over.origin ?? ('delegated' as Task['origin']),
    source: { channelId: '', threadId: null, messageId: null, userId: null, attachments: [] },
    direct: false, tainted: () => run.tainted(), run,
  };
}

/** An ApprovedTools port with nothing approved (Scheduler tests that do not exercise R4). */
export const noApprovedTools = {
  claim: async () => [], run: async () => ({ content: '' }), store: async () => undefined, unclaim: async () => undefined,
  pending: async () => [], delivered: async () => undefined,
};

/** In-memory RoomEntryStore with the real store's semantics (caps, retention, snowflake check); shared conformance test: db/repos/room-entries.int.test.ts. */
export class MemRoomEntries implements RoomEntryStore {
  readonly rows: RoomEntry[] = [];
  private seq = 0;
  async add(e: NewRoomEntry, cap?: { kinds: readonly RoomKind[]; max: number }): Promise<RoomEntry | null> {
    const body = e.body.slice(0, ROOM_BODY_MAX);
    if (body.trim() === '') return null;
    if (cap && e.taskId !== null && this.rows.filter((r) => r.taskId === e.taskId && cap.kinds.includes(r.kind)).length >= cap.max) return null;
    const row: RoomEntry = { id: ++this.seq, ...e, body, messageId: null, createdAt: new Date() };
    this.rows.push(row);
    const mine = this.rows.filter((r) => r.personaId === e.personaId);
    for (const old of mine.slice(0, Math.max(0, mine.length - ROOM_RETAIN))) this.rows.splice(this.rows.indexOf(old), 1);
    return { ...row };
  }
  async setMessage(id: number, messageId: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r && /^[0-9]{17,20}$/.test(messageId)) r.messageId = messageId;
  }
  async recent(personaIds: readonly string[], limit: number): Promise<RoomEntry[]> {
    return this.rows.filter((r) => personaIds.includes(r.personaId)).slice(-Math.max(1, limit)).map((r) => ({ ...r }));
  }
  async last(personaId: string, kinds: readonly RoomKind[], limit: number): Promise<RoomEntry[]> {
    return this.rows.filter((r) => r.personaId === personaId && kinds.includes(r.kind)).slice(-Math.max(1, limit)).reverse().map((r) => ({ ...r }));
  }
}
