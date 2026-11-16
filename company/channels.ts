/** #💬-ai-warroom: the bot-to-bot room. Work one department delegates to another opens here; humans do not command in it. */
export const AI_WARROOM_CHANNEL_ID = '1566366032094961705';
/** #🧾-bot-log (Logs category): system alerts. Never routed, never mappable. */
export const BOT_LOG_CHANNEL_ID = '1566454343820124352';
/** #🎯-company-goals as a text channel and as a forum (spec §5.2: the CEO receives goals posted there; R29). Neither can be mapped to a department (TW10). */
export const GOAL_TEXT_CHANNEL_ID = '1565651009076985956';
export const GOAL_FORUM_CHANNEL_ID = '1565652418383847514';
/** Channels that are never mapped to a department, whoever asks (the warroom, bot-log, and the goals channels that route to the CEO already: TW10). */
export const NEVER_MAPPED_CHANNEL_IDS: readonly string[] = [AI_WARROOM_CHANNEL_ID, BOT_LOG_CHANNEL_ID, GOAL_TEXT_CHANNEL_ID, GOAL_FORUM_CHANNEL_ID];
