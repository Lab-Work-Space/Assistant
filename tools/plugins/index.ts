import { classOf, CATALOG_NAMES } from '../manifest/catalog.js';
import type { ToolRegistry } from '../registry.js';
import type { ToolPlugin } from '../types.js';
import type { PluginDeps } from './deps.js';
import { clickupGroup } from './clickup/index.js';
import { docsGroup } from './docs/index.js';
import { forumGroup } from './forum/index.js';
import { githubGroup } from './github/index.js';
import { lessonsGroup } from './lessons/index.js';
import { mediaGroup } from './media/index.js';
import { musicGroup } from './music/index.js';
import { ocrGroup } from './ocr/index.js';
import { pinGroup } from './pin/index.js';
import { remindersGroup } from './reminders/index.js';
import { scheduleGroup } from './schedule/index.js';
import { watchGroup } from './watch/index.js';
import { webGroup } from './web/index.js';
import { workspaceGroup } from './workspace/index.js';
import { wsGroup } from './ws/index.js';

export type { PluginDeps } from './deps.js';

export type ToolGroup = { id: string; tools: ToolPlugin<any>[] };
/** R13: a missing key returns `{ id, disabled }` instead of throwing; only that group is off. */
export type GroupFactory = (deps: PluginDeps) => ToolGroup | { id: string; disabled: string; /** BOTLOG-1: off because a check or init FAILED (not because it is not configured). */ error?: true };

export type GroupsResult = { enabled: string[]; disabled: { id: string; why: string; error?: true }[] };

/**
 * Every feature task adds its own factory here (and its "tool schemas convert for Gemini" assertion). The array stays explicit: its order fixes registration order.
 * R4: a new plugin is a folder `tools/plugins/<x>/` with index.ts AND manifest.ts, one line here and one line in tools/manifest/catalog.ts (see README, "Adding a tool/plugin").
 * `registerGroups` refuses (boot fails) a tool of a group in this array that no manifest declares with the same group and kind; a completeness test names the missing line.
 */
export const pluginGroups: GroupFactory[] = [webGroup, remindersGroup, scheduleGroup, watchGroup, lessonsGroup, workspaceGroup, pinGroup, forumGroup, clickupGroup, githubGroup, ocrGroup, musicGroup, docsGroup, mediaGroup, wsGroup];

/**
 * Builds every group, then registers the enabled ones. A factory that returns `disabled` (or throws) is listed once and
 * skipped; duplicate tool names across groups throw before anything is registered, so a boot never half-registers.
 */
export function registerGroups(reg: ToolRegistry, factories: GroupFactory[], deps: PluginDeps): GroupsResult {
  const enabled: ToolGroup[] = [];
  const disabled = new Map<string, string>();
  const failed = new Set<string>();
  const checked = new Set<ToolGroup>(); // R4: groups built by a member of pluginGroups; they must be declared in the manifest
  for (const f of factories) {
    let g: ReturnType<GroupFactory>;
    try {
      g = f(deps);
    } catch (err) {
      deps.log?.warn({ errName: err instanceof Error ? err.name : 'unknown' }, 'tool group factory threw'); // the message may hold secrets: never logged
      disabled.set(`factory-${factories.indexOf(f)}`, 'the group failed to initialise');
      failed.add(`factory-${factories.indexOf(f)}`);
      continue;
    }
    if ('disabled' in g) {
      if (!disabled.has(g.id)) {
        disabled.set(g.id, g.disabled);
        if (g.error) failed.add(g.id);
      }
    } else enabled.push(g);
    if (!('disabled' in g) && pluginGroups.includes(f)) checked.add(g);
  }
  const catalog = new Set<string>(CATALOG_NAMES);
  const owner = new Map<string, string>();
  for (const n of reg.names()) owner.set(n, 'core');
  for (const g of enabled)
    for (const t of g.tools) {
      if (!t.kind) throw new Error(`tool ${t.name} in group ${g.id} has no kind (read|write|destructive)`);
      if (checked.has(g)) {
        const c = catalog.has(t.name) ? classOf(t.name) : undefined;
        if (!c) throw new Error(`tool ${t.name} in group ${g.id} is not declared in tools/plugins/${g.id}/manifest.ts`);
        if (c.group !== g.id) throw new Error(`tool ${t.name} in group ${g.id} is declared in group ${c.group}`);
        if (c.kind !== t.kind) throw new Error(`tool ${t.name} in group ${g.id} is declared with kind ${String(c.kind)} but has kind ${t.kind}`);
      } else if (catalog.has(t.name)) throw new Error(`tool ${t.name} in group ${g.id} reuses a declared tool name (a test group may not take a declared class)`); // PM-C10
      const prev = owner.get(t.name);
      if (prev !== undefined) throw new Error(`duplicate tool ${t.name} in groups ${prev} and ${g.id}`);
      owner.set(t.name, g.id);
    }
  for (const g of enabled) for (const t of g.tools) reg.register(t);
  return { enabled: enabled.map((g) => g.id), disabled: [...disabled].map(([id, why]) => ({ id, why, ...(failed.has(id) ? { error: true as const } : {}) })) };
}
