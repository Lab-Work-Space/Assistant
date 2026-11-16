import { redactText } from '../../core/index.js';
import { isDenied } from '../../company/denylist.js';
import { ephemeral, type InteractionLike, type Reply } from '../commands/types.js';
import { outcomeReply, syntheticMessage, type PrawCommandDeps } from './context.js';
import { lessonCmd } from './lesson.js';
import { playCmd, queueCmd, skipCmd, stopCmd, volumeCmd } from './music.js';
import { ocrCmd, receiptCmd } from './ocr.js';
import { remindCmd } from './remind.js';
import { scheduleCmd } from './schedule.js';
import { isVoiceButton, voiceButton, voiceCmd } from './voice.js';
import { watchCmd } from './watch.js';

/** `check` runs before anything is charged; the guard defers (public) before `run` and answers with editReply. */
export interface Handler {
  /** Has subcommands (the guard requires one); a plain command must not have one. */
  subs?: boolean;
  /** Defer ephemerally (replies that list stored items, P15). */
  ephemeral?: boolean;
  /** Public defer, but an ephemeral answer (a refusal) replaces the deferred reply with an ephemeral follow-up (music). */
  privateRefusals?: boolean;
  check?(i: InteractionLike, deps: PrawCommandDeps): Reply | null;
  run(i: InteractionLike, deps: PrawCommandDeps): Promise<Reply>;
}

/** `/ask <prompt>`: a synthetic human message to Praw only (origin slash is set by Scheduler.ask's default, never by content). */
const promptOf = (i: InteractionLike) => i.options.string('prompt')?.trim() ?? '';

const askCmd: Handler = { check: (i) => (promptOf(i) ? null : ephemeral('Tell me what to ask.')), async run(i, deps) {
  const msg = syntheticMessage(i, deps.isBotAdmin(i), promptOf(i));
  const out = await deps.ask(msg, { deliver: false, preCharged: true });
  await deps.audit({ actor: `user:${i.userId}`, action: 'praw.ask', outcome: out ? (out.stopped ?? 'ok') : 'refused' });
  if (!out || out.stopped === 'halted') return ephemeral('Praw is not taking requests right now (halted, paused or busy). Try again later.');
  return outcomeReply(out);
} };

const TABLE: Record<string, Handler> = { ask: askCmd, remind: remindCmd, schedule: scheduleCmd, watch: watchCmd, lesson: lessonCmd, ocr: ocrCmd, receipt: receiptCmd,
  play: playCmd, skip: skipCmd, queue: queueCmd, stop: stopCmd, volume: volumeCmd, voice: voiceCmd };

/**
 * Guard order: bot users and other guilds dropped silently, denylist, known command, per-user rate limit (one slot, taken here
 * and nowhere else on this path), then the handler. No admin gate (R7). Refusals are ephemeral and carry no input.
 * Returns the reply that was sent (null when dropped).
 */
export async function handlePrawInteraction(i: InteractionLike, deps: PrawCommandDeps): Promise<Reply | null> {
  if (i.userIsBot) return null; // P15
  if (i.guildId !== deps.guildId) return null; // D5
  // The only component Praw answers is her voice opt-in button (T37); config buttons are never reachable from here (R7).
  const button = isVoiceButton(i);
  if (!i.isChatInputCommand() && !button) return null;
  const refuse = async (r: Reply) => (await i.reply(r), r);
  if (i.channelId === null || isDenied(i.channelId, i.parentChannelId ?? null)) return refuse(ephemeral('Praw is not available in this channel.'));
  if (button) return voiceButton(i, deps);
  const handler = TABLE[i.commandName];
  if (!handler || Boolean(handler.subs) !== Boolean(i.subcommand)) return refuse(ephemeral('Unknown command.'));
  const bad = handler.check?.(i, deps) ?? null;
  if (bad) return refuse(bad);
  const t = deps.rate.take(i.userId);
  if (!t.ok) return refuse(ephemeral(`You can start at most ${deps.cfg.get('limits.prawPerUser10Min')} Praw requests per 10 minutes. Try again later.`));
  let reply: Reply;
  try {
    await i.deferReply({ ephemeral: handler.ephemeral ?? false });
    reply = await handler.run(i, deps);
  } catch (err) {
    deps.log.error({ command: i.commandName, err: redactText(err instanceof Error ? err.message : 'error') }, 'praw command failed');
    reply = ephemeral('That failed. Try again later.');
  }
  if (handler.privateRefusals && !handler.ephemeral && reply.ephemeral && i.followUp) {
    // a deferred public reply cannot become ephemeral: drop it and answer the invoker alone
    await i.deleteReply?.().catch(() => undefined);
    await i.followUp(reply);
    return reply;
  }
  const { followUps, ...rest } = reply;
  await i.editReply(followUps ? rest : reply);
  // I3: the rest of a long answer; register.ts masks each follow-up like the reply itself
  if (followUps && i.followUp) for (const f of followUps) await i.followUp(f);
  return reply;
}
