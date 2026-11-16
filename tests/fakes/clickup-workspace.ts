import { CLICKUP_BASE, fakeFetch, type HttpRoute, type RecordedRequest } from './http.js';

/**
 * CLICKUP-ALL-1: a ClickUp workspace fake (shapes as developer.clickup.com: GET /team, /team/{T}/space, /space/{id}/folder|list, /list/{id}, /team/{T}/task, /task/{id}).
 * State is mutable (`state.tasks[i].list = ...`, `state.lists[i].name = ...`) so a test can move a task or rename a list between a card and its approval.
 * Spaces not in `state.spaces` model ANOTHER workspace the same token can see: their lists and tasks answer 200, which is exactly the IDOR case.
 * Set `ignoreTeamFilters` to model a vendor that quietly ignores list_ids[] / space_ids[] (C8).
 * CLICKUP-MULTI-1: `more` adds further workspaces the token sees, each with its own spaces, lists, tasks and routes (GET /team/{id}/space and /task). The main
 * workspace (`teamId`, named `teamName`) keeps using `spaces` / `lists` / `tasks`. `spaceFail` makes that team's GET /space answer with that status;
 * `leakAll` makes every team's task route return the tasks of EVERY team (a vendor that ignores the team path).
 */
export type WsUser = { id: number; username: string; email?: string };
export type WsList = { id: string; name: string; spaceId: string; folder?: string; hiddenFolder?: boolean; statuses?: string[]; members?: WsUser[] };
export type WsTask = {
  id: string; name: string; listId: string; spaceId: string; teamId?: string; status?: { status: string; type: string }; assignees?: WsUser[];
  description?: string; date_updated?: string; due_date?: string | null; subtasks?: { id: string; name: string }[];
  /** extra raw fields the vendor returns and the tools must never render */
  extra?: Record<string, unknown>;
};
/** CLICKUP-HIER-1: an explicit folder (the implicit ones still come from `WsList.folder`). Its lists are the WsLists with the same `folder` name in the same space. */
export type WsFolder = { id: string; name: string; spaceId: string; hidden?: boolean; archived?: boolean };
export type WsTeam = { id: string; name: string; spaces: { id: string; name: string }[]; lists: WsList[]; tasks: WsTask[]; members?: WsUser[]; spaceFail?: number };
export type WsState = {
  token: string; teamId: string; teamName?: string; teams?: { id: string; name?: string }[]; teamsFail?: boolean | number; more?: WsTeam[]; leakAll?: boolean;
  spaces: { id: string; name: string }[]; lists: WsList[]; tasks: WsTask[];
  members: WsUser[]; comments: Record<string, { id: string; comment_text: string; user: { id?: number; username: string }; date: string }[]>;
  pageSize: number; ignoreTeamFilters: boolean; tooManyRequests: boolean;
  /** CLICKUP-HIER-1: explicit folders; space ids that answer GET /space/{id} with `archived: true`; a status per space/folder id for GET /space|folder/{id}; an override of every create POST answer; the id the next create returns. */
  folders: WsFolder[]; archivedSpaces: string[]; getStatus: Record<string, number>; /** GET /space|folder/{id} answers with this id instead (a vendor that returns another object) */ wrongId: Record<string, string>; /** space ids that GET /team/{t}/space leaves out although GET /space/{id} answers (a list that is behind) */ unlisted: string[]; postResponse?: { status?: number; body?: unknown }; nextId: number;
};

export const ws = (over: Partial<WsState> = {}): WsState => ({
  token: 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', teamId: '9001',
  spaces: [{ id: '501', name: 'Engineering' }, { id: '502', name: 'Marketing' }],
  lists: [
    { id: '7001', name: 'Sprint', spaceId: '501', folder: 'Backend', statuses: ['to do', 'in progress', 'complete'] },
    { id: '7002', name: 'Backlog', spaceId: '501', statuses: ['open', 'closed'] },
    { id: '7003', name: 'Campaigns', spaceId: '502', statuses: ['to do', 'done'] },
    { id: '7999', name: 'Foreign list', spaceId: '999', statuses: ['to do'] }, // another workspace
  ],
  tasks: [
    { id: 'a1', name: 'Write spec', listId: '7001', spaceId: '501', status: { status: 'in progress', type: 'custom' }, assignees: [{ id: 1, username: 'alice', email: 'alice@x.test' }], description: 'Spec body', date_updated: '1000' },
    { id: 'b2', name: 'Ship it', listId: '7002', spaceId: '501', status: { status: 'open', type: 'open' }, assignees: [], date_updated: '900' },
    { id: 'c3', name: 'Launch plan', listId: '7003', spaceId: '502', status: { status: 'to do', type: 'open' }, assignees: [], date_updated: '800' },
    { id: 'z9', name: 'Foreign secret', listId: '7999', spaceId: '999', status: { status: 'to do', type: 'open' }, assignees: [], date_updated: '700', description: 'OTHER WORKSPACE' },
  ],
  members: [{ id: 1, username: 'alice', email: 'alice@x.test' }, { id: 2, username: 'bob', email: 'bob@x.test' }],
  comments: { a1: [{ id: 'k1', comment_text: 'please do X', user: { id: 2, username: 'bob' }, date: '1' }] },
  pageSize: 100, ignoreTeamFilters: false, tooManyRequests: false, folders: [], archivedSpaces: [], getStatus: {}, wrongId: {}, unlisted: [], nextId: 8800,
  ...over,
});

const B = CLICKUP_BASE;
export function workspaceFetch(state: WsState) {
  const guard = (f: (r: RecordedRequest) => HttpRoute): HttpRoute => (r) => {
    if (r.headers['authorization'] !== state.token) return { status: 401, body: { err: 'Token invalid', ECODE: 'OAUTH_025' } };
    if (state.tooManyRequests) return { status: 429, body: { err: 'rate limit' } };
    return f(r);
  };
  const u = (r: RecordedRequest) => new URL(r.url).searchParams;
  const allLists = () => [...state.lists, ...(state.more ?? []).flatMap((t) => t.lists)];
  const allTasks = () => [...state.tasks, ...(state.more ?? []).flatMap((t) => t.tasks)];
  const allSpaces = () => [...state.spaces, ...(state.more ?? []).flatMap((t) => t.spaces)];
  const dataOf = (id: string): { spaces: WsState['spaces']; tasks: WsTask[]; spaceFail?: number } | undefined =>
    id === state.teamId ? { spaces: state.spaces, tasks: state.tasks } : (state.more ?? []).find((t) => t.id === id);
  const listOf = (id: string) => allLists().find((l) => l.id === id);
  const taskBody = (t: WsTask) => ({
    id: t.id, name: t.name, status: t.status ?? { status: 'to do', type: 'open' }, assignees: t.assignees ?? [], description: t.description, date_updated: t.date_updated,
    due_date: t.due_date ?? null, url: `https://app.clickup.com/t/${t.id}`, subtasks: t.subtasks ?? [],
    list: { id: t.listId, name: listOf(t.listId)?.name ?? '?', access: true }, space: { id: t.spaceId }, ...(t.teamId ? { team_id: t.teamId } : {}),
    inbound_address: 'secret-inbox@tasks.clickup.com', creator: { id: 7, email: 'creator@x.test' }, watchers: [{ email: 'watcher@x.test' }], custom_fields: [{ name: 'cf', value: 'cfvalue' }], attachments: [{ url: 'https://x/att' }], ...(t.extra ?? {}),
  });
  const listBody = (l: WsList) => ({
    id: l.id, name: l.name, space: { id: l.spaceId, name: allSpaces().find((s) => s.id === l.spaceId)?.name ?? 'Other' },
    folder: l.folder ? { id: 'f1', name: l.folder, hidden: false } : { id: 'f0', name: 'hidden', hidden: true }, statuses: (l.statuses ?? []).map((s) => ({ status: s })),
  });
  const routes: Record<string, HttpRoute> = {
    [`GET ${B}/team`]: guard(() => (state.teamsFail ? { status: typeof state.teamsFail === 'number' ? state.teamsFail : 500, body: {} } : {
      body: { teams: [...(state.teams ?? [{ id: state.teamId, name: state.teamName ?? 'WS' }]).map((t) => ({ ...t, members: state.members.map((m) => ({ user: m })) })), ...(state.more ?? []).map((t) => ({ id: t.id, name: t.name, members: (t.members ?? state.members).map((m) => ({ user: m })) }))] },
    })),
    [`GET ${B}/user`]: guard(() => ({ body: { user: { id: 77 } } })),
    [`GET ${B}/team/*`]: guard((r) => {
      const m = /\/team\/([^/]+)\/(space|task)$/.exec(r.url.split('?')[0]!);
      const data = m ? dataOf(m[1]!) : undefined;
      if (!m || !data) return { status: 404, body: { err: 'Team not found' } };
      if (m[2] === 'space') return data.spaceFail ? { status: data.spaceFail, body: {} } : { body: { spaces: data.spaces.filter((x) => !state.unlisted.includes(x.id)) } };
      const p = u(r);
      const page = Number(p.get('page') ?? '0');
      const closed = p.get('include_closed') === 'true';
      let all = (state.leakAll ? allTasks() : data.tasks).filter((t) => closed || (t.status?.type ?? 'open') !== 'closed');
      if (!state.ignoreTeamFilters) {
        const lids = p.getAll('list_ids[]');
        const sids = p.getAll('space_ids[]');
        if (lids.length) all = all.filter((t) => lids.includes(t.listId));
        if (sids.length) all = all.filter((t) => sids.includes(t.spaceId));
      }
      const slice = all.slice(page * state.pageSize, page * state.pageSize + state.pageSize);
      return { body: { tasks: slice.map(taskBody), last_page: (page + 1) * state.pageSize >= all.length } };
    }),
    // lookups keyed by prefix: lists, spaces, tasks
    [`GET ${B}/space/*`]: guard((r) => {
      const path = r.url.split('?')[0]!.slice(`${B}/space/`.length);
      const [sid = '', sub] = path.split('/');
      if (sub === undefined) { // GET /space/{id}
        const known = allSpaces().find((s) => s.id === sid);
        if (state.getStatus[sid]) return { status: state.getStatus[sid]!, body: { err: 'denied' } };
        if (!known && !allLists().some((l) => l.spaceId === sid)) return { status: 404, body: { err: 'Space not found' } };
        return { body: { id: state.wrongId[sid] ?? sid, name: known?.name ?? 'Other', private: false, archived: state.archivedSpaces.includes(sid) } };
      }
      const here = allLists().filter((l) => l.spaceId === sid);
      if (sub === 'folder') {
        const names = [...new Set([...here.filter((l) => l.folder).map((l) => l.folder!), ...state.folders.filter((f) => f.spaceId === sid && !f.archived).map((f) => f.name)])];
        return { body: { folders: names.map((n) => ({ id: state.folders.find((f) => f.name === n && f.spaceId === sid)?.id ?? `f-${n}`, name: n, lists: here.filter((l) => l.folder === n).map((l) => ({ id: l.id, name: l.name })) })) } };
      }
      return { body: { lists: here.filter((l) => !l.folder).map((l) => ({ id: l.id, name: l.name })) } };
    }),
    [`GET ${B}/folder/*`]: guard((r) => {
      const [fid = '', sub] = r.url.split('?')[0]!.slice(`${B}/folder/`.length).split('/');
      if (state.getStatus[fid]) return { status: state.getStatus[fid]!, body: { err: 'denied' } };
      const f = state.folders.find((x) => x.id === fid);
      if (!f) return { status: 404, body: { err: 'Folder not found' } };
      const lists = allLists().filter((l) => l.folder === f.name && l.spaceId === f.spaceId);
      if (sub === 'list') return { body: { lists: lists.map((l) => ({ id: l.id, name: l.name })) } };
      return { body: { id: state.wrongId[fid] ?? f.id, name: f.name, hidden: f.hidden === true, archived: f.archived === true, space: { id: f.spaceId, name: allSpaces().find((s) => s.id === f.spaceId)?.name ?? 'Other' }, lists: lists.map((l) => ({ id: l.id, name: l.name })) } };
    }),
    [`GET ${B}/list/*`]: guard((r) => {
      const path = r.url.split('?')[0]!.slice(`${B}/list/`.length);
      const [id, sub] = path.split('/');
      const l = listOf(id!);
      if (!l) return { status: 404, body: { err: 'List not found' } };
      if (sub === 'member') return { body: { members: l.members ?? state.members } };
      if (sub === 'task') return { body: { tasks: allTasks().filter((t) => t.listId === id).map(taskBody), last_page: true } };
      return { body: listBody(l) };
    }),
    [`GET ${B}/task/*`]: guard((r) => {
      const path = r.url.split('?')[0]!.slice(`${B}/task/`.length);
      const [id, sub] = path.split('/');
      const t = allTasks().find((x) => x.id === id);
      if (!t) return { status: 404, body: { err: 'Task not found' } };
      if (sub === 'comment') return { body: { comments: state.comments[id!] ?? [] } };
      return { body: taskBody(t) };
    }),
    [`PUT ${B}/task/*`]: guard(() => ({ body: { id: 'ok' } })),
    [`POST ${B}/task/*`]: guard(() => ({ body: { id: 'c9', hist_id: 'h9', date: 1 } })),
    [`POST ${B}/list/*`]: guard((r) => ({ body: { id: 'new1', name: (JSON.parse(r.body ?? '{}') as { name?: string }).name } })),
    // CLICKUP-HIER-1 create routes (createspace, createfolder, createlist, createfolderlesslist)
    [`POST ${B}/team/*`]: guard((r) => {
      const m = /\/team\/([^/]+)\/space$/.exec(r.url);
      const data = m ? dataOf(m[1]!) : undefined;
      if (!data) return { status: 404, body: { err: 'Route not found' } };
      if (state.postResponse) return state.postResponse;
      const b = JSON.parse(r.body ?? '{}') as { name?: string };
      const id = String(state.nextId++);
      data.spaces.push({ id, name: b.name ?? '?' });
      return { body: { id, name: b.name, private: false, statuses: [], multiple_assignees: true, features: {} } };
    }),
    [`POST ${B}/space/*`]: guard((r) => {
      const m = /\/space\/([^/]+)\/(folder|list)$/.exec(r.url);
      if (!m) return { status: 404, body: { err: 'Route not found' } };
      if (state.postResponse) return state.postResponse;
      const b = JSON.parse(r.body ?? '{}') as { name?: string };
      const id = String(state.nextId++);
      if (m[2] === 'folder') {
        state.folders.push({ id, name: b.name ?? '?', spaceId: m[1]! });
        return { body: { id, name: b.name, hidden: false, space: { id: m[1], name: allSpaces().find((s) => s.id === m[1])?.name ?? 'Other' }, lists: [] } };
      }
      state.lists.push({ id, name: b.name ?? '?', spaceId: m[1]!, statuses: ['to do', 'done'] });
      return { body: { id, name: b.name, space: { id: m[1] } } };
    }),
    [`POST ${B}/folder/*`]: guard((r) => {
      const m = /\/folder\/([^/]+)\/list$/.exec(r.url);
      const f = m ? state.folders.find((x) => x.id === m[1]) : undefined;
      if (!f) return { status: 404, body: { err: 'Route not found' } };
      if (state.postResponse) return state.postResponse;
      const b = JSON.parse(r.body ?? '{}') as { name?: string };
      const id = String(state.nextId++);
      state.lists.push({ id, name: b.name ?? '?', spaceId: f.spaceId, folder: f.name, statuses: ['to do', 'done'] });
      return { body: { id, name: b.name, space: { id: f.spaceId }, folder: { id: f.id } } };
    }),
    [`DELETE ${B}/task/*`]: guard(() => ({ status: 204 })),
  };
  return fakeFetch(routes);
}
