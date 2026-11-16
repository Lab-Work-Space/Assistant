import { welcomeMessageProblem } from '../config/welcome.js';
import { redactText } from '../core/logger.js';
import { CONFIG_CHANNEL_ID } from '../discord/commands/types.js';
import type { ExecRepo, OutboxRow } from '../db/repos/exec.js';
import type { DiscordPort } from '../discord/port.js';

/**
 * Posts what the executor queued (migration 014, exec_outbox): the welcome post (as Praw), raid and refusal alerts and the moderation summaries
 * (as hq, to #🧾-bot-log). The executor has no Send Messages and no other bot's token, so it cannot post; this is the only way its words reach
 * Discord. Every post re-validates what it publishes: a forged outbox row can at worst repeat a validated welcome or print a short alert.
 */
export interface OutboxDeps {
  exec: Pick<ExecRepo, 'pending' | 'markDone'>;
  port: Pick<DiscordPort, 'post'>;
  cfg: { get(key: 'welcome.enabled'): boolean; get(key: 'welcome.message'): string; get(key: 'welcome.channelId'): string | null };
  botLogChannelId: string;
  log: { error(o: unknown, m?: string): void };
  now?: () => number;
  intervalMs?: number;
}

const STALE_MS = 3600_000;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

export class OutboxPump {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: OutboxDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? 3000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running.catch(() => undefined);
  }

  /** One pass; serialized, so two overlapping ticks never post a row twice. */
  tick(): Promise<number> {
    const run = this.running.then(() => this.pass(), () => this.pass());
    this.running = run.catch(() => undefined);
    return run;
  }

  private async pass(): Promise<number> {
    let posted = 0;
    let rows: OutboxRow[];
    try {
      rows = await this.d.exec.pending(20);
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'outbox read failed');
      return 0;
    }
    const now = (this.d.now ?? Date.now)();
    for (const row of rows) {
      try {
        // a row that could not be posted for an hour is dropped (a welcome for a member who left long ago is no longer welcome)
        if (now - row.createdAt.getTime() <= STALE_MS) posted += (await this.handle(row)) ? 1 : 0;
        await this.d.exec.markDone(row.id);
      } catch (err) {
        this.d.log.error({ err: err instanceof Error ? err.name : 'error', id: row.id }, 'outbox post failed; will retry');
      }
    }
    return posted;
  }

  private async handle(row: OutboxRow): Promise<boolean> {
    const hq = { kind: 'head', dept: 'hq' } as const;
    const botLog = { channelId: this.d.botLogChannelId };
    switch (row.kind) {
      case 'alert':
        await this.d.port.post(hq, botLog, { type: 'alert', origin: 'governance', title: text(row.payload.title, 200) || 'Executor alert', body: text(row.payload.text, 1500) });
        return true;
      case 'summary':
        await this.d.port.post(hq, botLog, { type: 'report', origin: 'governance', title: 'Server change', body: text(row.payload.text, 500) });
        return true;
      case 'welcome.post': {
        const userId = text(row.payload.userId, 20);
        const msg = this.d.cfg.get('welcome.message');
        const channelId = this.d.cfg.get('welcome.channelId');
        if (!/^\d{17,20}$/.test(userId) || !this.d.cfg.get('welcome.enabled') || !channelId || !msg || welcomeMessageProblem(msg) !== null) return false;
        // S11: Praw posts, and the joining member's mention is the only mention allowed.
        await this.d.port.post({ kind: 'head', dept: 'praw' }, { channelId }, { type: 'chat', origin: 'governance', body: msg.replaceAll('{user}', `<@${userId}>`), mentionUsers: [userId] });
        return true;
      }
      case 'deploy.result': {
        // Gate 1 V21/V23: the result text comes from the VPS (untrusted): redacted again, capped, and posted only into the one channel deploy cards live in.
        const cardId = text(row.payload.cardId, 32);
        if (text(row.payload.channelId, 20) !== CONFIG_CHANNEL_ID || !/^[0-9a-f]{32}$/.test(cardId)) return false;
        await this.d.port.post(hq, { channelId: CONFIG_CHANNEL_ID }, { type: 'report', origin: 'governance', title: 'VPS deploy', body: redactText(text(row.payload.text, 1500)).replace(/@/g, '@\u200b') });
        return true;
      }
      case 'code.result': {
        // Gate 1 self-code X25: the text is written by executor code from fixed phrases and ids; still redacted, capped and defanged, and posted only to #setting.
        const cardId = text(row.payload.cardId, 32);
        if (text(row.payload.channelId, 20) !== CONFIG_CHANNEL_ID || !/^[0-9a-f]{32}$/.test(cardId)) return false;
        await this.d.port.post(hq, { channelId: CONFIG_CHANNEL_ID }, { type: 'report', origin: 'governance', title: 'Code change', body: redactText(text(row.payload.text, 600)).replace(/@/g, '@\u200b') });
        return true;
      }
    }
  }
}
