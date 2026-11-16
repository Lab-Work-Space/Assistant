import { isExcludedChannel, isDeniedCategory } from '../../company/exclusion.js';
import type { ConfigStore } from '../../config/store.js';
import type { Department } from '../../db/repos/index.js';
import type { Approval } from '../../db/repos/ledger.js';
import type { Task } from '../../db/repos/tasks.js';
import type { DiscordPort } from '../port.js';
import { CONFIG_CHANNEL_ID } from '../commands/types.js';

// R4: the sensitive-tool floor lives in tools/manifest/floor.ts (a leaf, moved verbatim, FROZEN: never extended) and is re-exported here under the same name.
// A new tool declares `sensitive` in its manifest instead; an undeclared name is sensitive (FAIL_CLOSED), so a name that merely avoids the prefixes below is never non-sensitive.
import { SENSITIVE_TOOL } from '../../tools/manifest/floor.js';
import { classOf } from '../../tools/manifest/catalog.js';
export { SENSITIVE_TOOL };

/** B7: the one place that says a tool may leave #⚙️-setting (WS7 card rooms) and join an approval batch; never copy the regex. R4: non-sensitive needs BOTH the floor not matching AND a declared `sensitive: false`. */
export const isNonSensitiveTool = (toolName: string): boolean => !SENSITIVE_TOOL.test(toolName) && classOf(toolName).sensitive === false; // R4: the floor first, then the declared class; an undeclared name is FAIL_CLOSED (sensitive)

export interface ApprovalRoomDeps {
  cfg: Pick<ConfigStore, 'get'>;
  tasks: { get(id: string): Promise<Task | null> };
  port: Pick<DiscordPort, 'approvalRoomProblem' | 'listGuildChannels'>;
  org: { heads(): Department[] };
  /** Bot user id -> department of the online head bots. */
  botUserIds: () => ReadonlyMap<string, string>;
  adminRoleId: string;
  /** LW Admin's user id (the executor), when it is running. */
  lwAdminUserId?: () => Promise<string | null>;
  /** One notice per room per process when a mapped room fails the check (goes to #🧾-bot-log). */
  alert: (text: string) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
}

/**
 * Where an approval card is posted (spec §2, Gate 1 WS6 to WS8). Only estimate cards and non-sensitive tool cards of a task with an origin
 * category go to that category's approvals room, and only when the mapped room passes the live check; everything else, every failure and the
 * DENIED IT category fall back to #⚙️-setting. The rooms are post-only: the scheduler gets `rooms()` as its post-only hook.
 */
export class ApprovalRooms {
  private readonly alerted = new Set<string>();

  constructor(private readonly d: ApprovalRoomDeps) {}

  /** The currently mapped rooms (read live from the config, never cached): the post-only set. */
  rooms(): string[] {
    return Object.values(this.d.cfg.get('approvals.channelByCategory'));
  }

  /** WS7 allow-list: whether this approval may be shown in a category room at all. */
  routable(a: Approval): boolean {
    if (a.kind === 'estimate' && !a.toolName) return true;
    return a.kind === 'tool' && !!a.toolName && isNonSensitiveTool(a.toolName);
  }

  async channelFor(a: Approval): Promise<string> {
    try {
      if (!this.routable(a)) return CONFIG_CHANNEL_ID;
      const task = await this.d.tasks.get(a.taskId);
      const cat = task?.originCategoryId ?? null;
      if (!cat || isDeniedCategory(cat)) return CONFIG_CHANNEL_ID;
      const map = this.d.cfg.get('approvals.channelByCategory');
      const room = Object.hasOwn(map, cat) ? map[cat]! : null;
      if (!room) return CONFIG_CHANNEL_ID;
      const problem = await this.problem(room, cat);
      if (problem) {
        await this.warn(room, cat, problem);
        return CONFIG_CHANNEL_ID;
      }
      return room;
    } catch (err) {
      this.d.log.error({ err }, 'approval room choice failed; using #setting');
      return CONFIG_CHANNEL_ID;
    }
  }

  /** WS8: why `room` cannot serve `cat` right now, or null. */
  async problem(room: string, cat: string): Promise<string | null> {
    // The room itself is in the post-only set, so only the static and mod-room parts of the exclusion apply here.
    if (isExcludedChannel(room, null, { modRoomId: this.d.cfg.get('roles.modRoomId') })) return 'the room is an excluded channel';
    if (isDeniedCategory(cat)) return 'the category is denied';
    const channels = await this.d.port.listGuildChannels();
    const category = channels.find((c) => c.id === cat && c.type === 4);
    if (!category) return 'the category was not found';
    const head = this.d.org.heads().find((h) => h.categoryNamePattern !== '' && safeTest(h.categoryNamePattern, category.name));
    const bots = this.d.botUserIds();
    const users = new Set<string>();
    for (const [uid, dept] of bots) if (dept === head?.id || dept === 'praw' || dept === 'hq') users.add(uid); // hq posts and serves the cards
    const lw = await this.d.lwAdminUserId?.().catch(() => null);
    if (lw) users.add(lw);
    return this.d.port.approvalRoomProblem(room, cat, { roleIds: [this.d.adminRoleId], userIds: [...users] });
  }

  private async warn(room: string, cat: string, why: string): Promise<void> {
    if (this.alerted.has(room)) return;
    this.alerted.add(room);
    await this.d.alert(`The approvals room <#${room}> for category ${cat} was not used (${why.replace(/[^\w @.,:'-]/g, '').slice(0, 120)}); cards for it go to #⚙️-setting.`);
  }
}

function safeTest(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(name);
  } catch {
    return false;
  }
}
