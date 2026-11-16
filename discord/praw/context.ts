import { randomUUID } from 'node:crypto';
import type { AgentOutcome } from '../../agents/loop/loop.js';
import type { VisionCap } from '../../agents/loop/vision.js';
import type { IncomingMessage } from '../../company/types.js';
import { buildMessage } from '../embeds/index.js';
import type { Scheduler } from '../../agents/scheduler/scheduler.js';
import type { PrawRateLimit } from '../../agents/call/rate.js';
import type { Org } from '../../company/org.js';
import type { ConfigStore } from '../../config/store.js';
import type { JobRepo } from '../../db/repos/jobs.js';
import type { LessonRepo } from '../../db/repos/lessons.js';
import type { WatchRepo } from '../../db/repos/watches.js';
import type { WatchNet } from '../../tools/plugins/watch/index.js';
import type { ReminderRepo } from '../../db/repos/reminders.js';
import type { MusicPlayer } from '../../voice/music/index.js';
import type { VoiceChat } from '../../voice/chat/index.js';
import type { AuditFn } from '../../governance/index.js';
import { ephemeral, type InteractionLike, type Reply } from '../commands/types.js';

export interface PrawCommandDeps {
  guildId: string;
  org: Pick<Org, 'dept'>;
  cfg: Pick<ConfigStore, 'get'>;
  /** R8: the shared per-user Praw counter; the guard takes exactly one slot per interaction. */
  rate: PrawRateLimit;
  ask: Scheduler['ask'];
  /** Task 34 (P15): the daily OCR cap; the commands only peek (the tools take the slot). Absent means no daily cap check here. */
  vision?: Pick<VisionCap, 'peek'>;
  /** Task 16: `/remind`. */
  reminders: Pick<ReminderRepo, 'add' | 'list' | 'cancel' | 'cancelAny'>;
  /** Task 17: `/schedule`. */
  schedules: Pick<JobRepo, 'add' | 'list' | 'remove' | 'removeAny'>;
  /** Task 18: `/watch`; absent means the command answers "not available". */
  watches?: Pick<WatchRepo, 'add' | 'list' | 'remove' | 'removeAny'>;
  /** Task 19: `/lesson`; absent means the command answers "not available". */
  lessons?: Pick<LessonRepo, 'add' | 'list' | 'remove' | 'setActive'>;
  /** The resolver and port allow-list for the add-time SSRF check. */
  watchNet?: WatchNet;
  /** Task 36: `/play` `/skip` `/queue` `/stop` `/volume`; absent (music disabled, P22) means the commands answer "not available". */
  music?: Pick<MusicPlayer, 'play' | 'skip' | 'stop' | 'list' | 'setVolume'>;
  /** Task 37: `/voice join|leave` and the opt-in button; absent (voice disabled, P22) means "not available". */
  voiceChat?: Pick<VoiceChat, 'join' | 'leave' | 'optIn'>;
  clock: () => number;
  audit: AuditFn;
  log: { error(obj: unknown, msg?: string): void };
  /** PF7: the existing Bot Admin role check, for the commands that need it (/lesson and later). Unused by /ask. */
  isBotAdmin(member: Pick<InteractionLike, 'memberRoleIds'>): boolean;
}

export type PrawCommandBase = Omit<PrawCommandDeps, 'isBotAdmin'> & { adminRoleId: string };

/** Builds the deps; `isBotAdmin` is the same role-id check the config path uses (an unset role id grants nobody). */
export function prawCommandDeps(b: PrawCommandBase): PrawCommandDeps {
  const { adminRoleId, ...rest } = b;
  return { ...rest, isBotAdmin: (m) => adminRoleId !== '' && m.memberRoleIds.includes(adminRoleId) };
}

/** P15: replies that list stored items are visible to the invoker only. */
export const prawListReply = (body: string): Reply => ephemeral(body.slice(0, 2000));

const PRAW_COLOR = 0xf48fb1;
const NO_PING = { parse: [] } as { parse: [] };

/** Follow-up messages a long /ask answer may use after its first one; anything past them is cut with a marker. */
export const MAX_FOLLOW_UPS = 5;
export const TRUNCATED = '[truncated]';

/** The slash reply for a finished Praw run: the first message, the rest of a long answer as follow-ups (capped). */
export const outcomeReply = (o: AgentOutcome): Reply => {
  // ASKBACK-1 (AB4, Gate 2 G2AB-01): a run that sent a question posts nothing of its own (its payload is the internal NO_REPLY marker); one fixed line instead.
  if (o.asked) return ephemeral('Asked a question in the task thread; waiting for the answer.');
  const [first, ...rest] = buildMessage(o.payload, { dept: 'praw', deptColor: PRAW_COLOR });
  const toReply = (m: typeof first): Reply => ({ ...(m?.content ? { content: m.content } : {}), embeds: m?.embeds ?? [], ephemeral: false, allowedMentions: NO_PING });
  const followUps = rest.slice(0, MAX_FOLLOW_UPS).map(toReply);
  if (rest.length > MAX_FOLLOW_UPS) {
    // the marker goes after the answer's last shown text (the last embed's description) when it fits, else as message content
    const last = followUps[followUps.length - 1]!;
    const e = last.embeds?.at(-1);
    if (e && (e.description ?? '').length + TRUNCATED.length + 1 <= 4096) last.embeds = [...last.embeds!.slice(0, -1), { ...e, description: `${e.description ?? ''}\n${TRUNCATED}`.trimStart() }];
    else last.content = TRUNCATED;
  }
  return { ...toReply(first), ...(followUps.length ? { followUps } : {}) };
};

/**
 * A synthetic human message to Praw only for a Praw slash command (origin is set by Scheduler.ask, never by content). `attachments`
 * ride on the message so the run's ToolSource carries them (PF20); their url is never in `content`.
 */
export function syntheticMessage(i: InteractionLike, isAdmin: boolean, content: string, attachments: IncomingMessage['attachments'] = []): IncomingMessage {
  const parent = i.parentChannelId ?? null;
  const channelId = i.channelId ?? '';
  return {
    id: `interaction:${i.id ?? randomUUID()}`,
    channelId,
    parentChannelId: parent,
    threadId: parent ? channelId : null,
    author: { id: i.userId, name: i.userName ?? i.userId, kind: 'human' },
    content,
    mentionedHeads: ['praw'],
    isAdmin,
    attachments,
    origin: 'slash',
  };
}
