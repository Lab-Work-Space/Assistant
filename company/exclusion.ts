import { BOT_LOG_CHANNEL_ID } from './channels.js';
import { DENIED_CATEGORY_IDS, isDenied } from './denylist.js';

/** #⚙️-setting, #📋-tasks, #🔁-direct, #🧾-bot-log: slash interactions or logs only, messages are never routed (Gate 1 D21). */
export const IGNORED_CHANNEL_IDS: readonly string[] = ['1565667791938387969', '1565671253803794494', '1565671325597700157', BOT_LOG_CHANNEL_ID];

/** Values that change at runtime and are therefore read at each call (never cached): the live mod room and the post-only channels. */
export interface LiveExclusions {
  /** The live value of `roles.modRoomId`. */
  modRoomId?: string | null;
  /** Channels bots may post in but never read or route from: the approvals rooms, #📢-announcements, #🎯-daily-goal (ids are supplied once they exist). */
  postOnly?: readonly string[];
}

/**
 * Gate 1 WS6: the ONE predicate that decides whether a channel (or a thread under it) is outside bot routing, mention resolution,
 * delegation-thread placement and card/daily-post routing: DENIED channels (and threads under them), the ignored system channels,
 * #bot-log, #tasks, #setting, the live mod room and every post-only room.
 */
export function isExcludedChannel(channelId: string, parentChannelId: string | null, live: LiveExclusions = {}): boolean {
  if (isDenied(channelId, parentChannelId)) return true;
  const ids = [channelId, ...(parentChannelId ? [parentChannelId] : [])];
  if (ids.some((i) => IGNORED_CHANNEL_IDS.includes(i))) return true;
  if (live.modRoomId && ids.includes(live.modRoomId)) return true;
  return !!live.postOnly && ids.some((i) => live.postOnly!.includes(i));
}

/** A DENIED category (IT GENERAL): no origin category, no approvals room, no thread placement. Human routing into it is unchanged. */
export const isDeniedCategory = (categoryId: string | null): boolean => categoryId !== null && DENIED_CATEGORY_IDS.includes(categoryId);
