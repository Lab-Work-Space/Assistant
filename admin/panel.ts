import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { redactText } from '../core/logger.js';
import type { ConfigStore } from '../config/store.js';
import { CONFIG_CHANNEL_ID, ephemeral, type InteractionLike, type ModalSpec, type Outcome } from '../discord/commands/types.js';
import { escapeCardText } from '../discord/embeds/approval.js';
import type { PanelPayload, PanelPort } from '../discord/panel-port.js';
import type { AuditFn } from '../governance/audit.js';
import { SERVER_OFF, SECTIONS, type SettingsAction, type SettingsRegistry } from './settings.js';

const CUSTOM_ID = /^panel:([a-z]+):([a-z_]+)$/;
const SELECT_MAIN = 'panel:all:pick';
const SELECT_SERVER = 'panel:srv:pick';
const REFRESH = 'panel:all:refresh';
const REPOST_GAP_MS = 10 * 60_000;
const EMBED_COLOR = 0x95a5a6;
const MODAL_TITLE_MAX = 45;
const MODAL_LABEL_MAX = 45;

export interface PanelDeps {
  guildId: string;
  adminRoleId: string;
  settings: SettingsRegistry;
  cfg: Pick<ConfigStore, 'get'>;
  port: PanelPort;
  hqUserId: () => string | undefined;
  /** The stored panel message (S37b). Buttons are honoured only on this id. */
  state: { get(): Promise<{ channelId: string; messageId: string; postedAt: Date } | null>; set(channelId: string, messageId: string): Promise<void> };
  /** One line about the bots (names and on/off), from the org. */
  bots: () => string;
  /** Overrides the live value list (tests). Default: the code-chosen keys below. */
  values?: () => { name: string; value: unknown }[];
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void; info(o: unknown, m?: string): void };
  now?: () => number;
}

/** S37e: only these config keys are shown on the panel, all of them inside ADMIN_READ_KEYS. */
export const PANEL_LIVE_KEYS = ['schedule.offDays', 'budget.companyDailyUsd', 'budget.botDailyUsd', 'budget.taskUsd', 'approval.thresholdUsd', 'provider.default'] as const;

const NO_PING = { parse: [] as [] };
const actor = (userId: string) => `user:${userId} via panel`;

/** A value as the panel prints it: a value the masker would change is never shown (S37e). */
function show(v: unknown): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined');
  if (redactText(s) !== s) return '(hidden)';
  return escapeCardText(s, 300);
}

/**
 * The Discord settings panel (spec A; Gate 1 S37a-S37e). One persistent message in #setting with select menus (each option opens a modal)
 * and a Refresh button. A submission becomes the SAME structured op and the SAME confirmation card as the natural-language and slash flows:
 * it goes through `SettingsRegistry.propose`, i.e. through AdminConsole. This class has no write path of its own.
 */
export class SettingsPanel {
  private lastRepost = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly d: PanelDeps) {}
  private now(): number { return (this.d.now ?? Date.now)(); }

  // ---- render ----

  private options(server: boolean): { label: string; value: string; description: string }[] {
    const sections = new Map(SECTIONS.map((s) => [s.id, s.label]));
    return this.d.settings.list().filter((a) => (a.family === 'server') === server).slice(0, 25)
      .map((a) => ({ label: a.label.slice(0, 100), value: a.id, description: (sections.get(a.section) ?? a.section).slice(0, 100) }));
  }

  async render(): Promise<PanelPayload> {
    const live = this.d.values ? this.d.values() : [
      ...PANEL_LIVE_KEYS.map((k) => ({ name: k, value: this.d.cfg.get(k as never) })),
      { name: 'schedule.holidays (count)', value: (this.d.cfg.get('schedule.holidays' as never) as unknown[]).length },
      { name: 'bots', value: this.d.bots() },
    ];
    const caps = await this.d.settings.capabilities();
    const embed = {
      title: 'Settings / ตั้งค่า',
      description: 'Choose an action from a menu; a form opens. Your change appears as a confirmation card in this channel and applies only when you press Confirm.\nเลือกรายการจากเมนู กรอกฟอร์ม แล้วกดยืนยันที่การ์ดที่ขึ้นในช่องนี้',
      color: EMBED_COLOR,
      fields: live.slice(0, 20).map((v) => ({ name: escapeCardText(v.name, 100), value: show(v.value) || '-' })),
      footer: { text: caps.server ? `Server management: ${caps.server}` : 'Server management: enabled' },
    };
    const menu = (id: string, placeholder: string, server: boolean) => {
      const options = this.options(server);
      return options.length ? new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder.slice(0, 150)).addOptions(options)).toJSON() : null;
    };
    const rows = [
      menu(SELECT_MAIN, 'Settings: holidays, budget, bots, channels, permissions', false),
      menu(SELECT_SERVER, caps.server ? `Server management (${caps.server})` : 'Server management', true),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(REFRESH).setLabel('Refresh').setStyle(ButtonStyle.Secondary)).toJSON(),
    ].filter((r): r is NonNullable<typeof r> => r !== null);
    return { embeds: [embed], components: rows as PanelPayload['components'] };
  }

  // ---- interactions ----

  /** S37b: guild, channel, admin role from the payload, then the stored panel message id authored by hq. Returns a refusal reply or null. */
  private async check(i: InteractionLike, why: (w: string) => Promise<Outcome>): Promise<Outcome | null> {
    if (i.guildId !== this.d.guildId) return why('guild');
    if (i.channelId !== CONFIG_CHANNEL_ID) return why('channel');
    if (!this.d.adminRoleId || !i.memberRoleIds.includes(this.d.adminRoleId)) return why('role');
    const st = await this.d.state.get();
    const hq = this.d.hqUserId();
    if (!st || !hq || st.channelId !== CONFIG_CHANNEL_ID || i.messageId !== st.messageId || i.messageAuthorId !== hq) return why('message');
    return null;
  }

  async handle(i: InteractionLike): Promise<Outcome> {
    const refuse = async (w: string): Promise<Outcome> => {
      await this.d.audit({ actor: actor(i.userId), action: 'panel.refused', tool: i.isModalSubmit() ? 'modal' : 'component', outcome: `refused:${w}` });
      return ephemeral(w === 'role' ? 'Only Bot Admins can do this.' : w === 'channel' ? 'Use this in #⚙️-setting.' : w === 'guild' ? 'Not available here.' : 'Panel: this button belongs to an old panel message. Use the current one.');
    };
    const bad = await this.check(i, refuse);
    if (bad) return bad;
    const m = CUSTOM_ID.exec(i.customId);
    if (!m) return ephemeral('Unknown action.');
    if (i.isModalSubmit()) return this.submit(i, m[1]!, m[2]!);
    if (i.customId === REFRESH && i.isButton()) {
      void this.refresh(); // Discord wants an answer within 3 s: reply first, edit the message in the background
      return ephemeral('Refreshing the panel.');
    }
    if (i.isStringSelectMenu?.() && (i.customId === SELECT_MAIN || i.customId === SELECT_SERVER)) return this.pick(i, i.customId === SELECT_SERVER);
    return ephemeral('Unknown action.');
  }

  /** S37c: the value must be in the option set code rendered; nothing else is accepted. A button never writes; it opens a modal. */
  private async pick(i: InteractionLike, server: boolean): Promise<Outcome> {
    const value = i.values?.[0] ?? '';
    if (i.values?.length !== 1 || !this.options(server).some((o) => o.value === value)) return ephemeral('Unknown option.');
    const a = this.d.settings.action(value)!;
    const caps = await this.d.settings.capabilities();
    // Discord sends nothing when the option that is already selected is picked again: edit the message (it resets the menu) after every pick.
    void this.refresh();
    if (caps[a.family]) return ephemeral(a.family === 'server' ? `${a.label}: ${SERVER_OFF}.` : `${a.label}: ${caps[a.family]}.`);
    if (a.fields.length === 0) return ephemeral(`${a.label}: ${SERVER_OFF}.`);
    return { modal: modalOf(a) };
  }

  private async submit(i: InteractionLike, section: string, id: string): Promise<Outcome> {
    const a = this.d.settings.action(id);
    // The modal id must name a known, fielded action of that very section: a forged id proposes nothing.
    if (!a || a.section !== section || a.fields.length === 0) return ephemeral('Unknown action.');
    const values: Record<string, string> = {};
    for (const f of a.fields) {
      const v = i.field(f.id) ?? '';
      if (v.length > f.maxLength) return ephemeral(`Not proposed: ${f.label} is too long (at most ${f.maxLength} characters).`); // refused, never cut
      values[f.id] = v;
    }
    const built = this.d.settings.build(a.id, values);
    if (!built.ok) return ephemeral(`Not proposed: ${built.error}`);
    // S37d: the submitter is the proposer; the text was typed by an admin and never went to a model, so tainted is false.
    const r = await this.d.settings.propose({ userId: i.userId, tainted: false, via: 'panel' }, built);
    if (!r.ok) return ephemeral(`Not proposed: ${r.error}`);
    return ephemeral('A confirmation card was posted in this channel. Nothing changes until you press Confirm (valid 15 minutes).');
  }

  // ---- the message ----

  /** Resolves when every queued edit has finished (tests). */
  idle(): Promise<unknown> {
    return this.chain;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Boot: refresh the stored message, or re-post when it is gone (S37b). Never finds the panel by content. */
  ensure(): Promise<void> {
    return this.serial(async () => {
      const st = await this.d.state.get();
      if (st && st.channelId === CONFIG_CHANNEL_ID) {
        const r = await this.d.port.fetch(st.channelId, st.messageId);
        if (r.state === 'error') return this.d.log.error({}, 'settings panel fetch failed; not re-posting');
        if (r.state === 'ok' && r.authorId === this.d.hqUserId()) return this.edit(st.messageId);
      }
      await this.repost(st?.postedAt.getTime() ?? 0);
    }).catch((err: unknown) => this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'settings panel boot failed'));
  }

  /** S37e: after each apply. Edits the stored message only; a failure is logged and never re-posts in a loop. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      const st = await this.d.state.get();
      if (st) await this.edit(st.messageId);
    }).catch((err: unknown) => this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'settings panel refresh failed'));
  }

  private async edit(messageId: string): Promise<void> {
    await this.d.port.edit(CONFIG_CHANNEL_ID, messageId, await this.render());
  }

  private async repost(storedAt: number): Promise<void> {
    const now = this.now();
    if (now - Math.max(this.lastRepost, storedAt) < REPOST_GAP_MS && (this.lastRepost > 0 || storedAt > 0)) return this.d.log.info({}, 'settings panel re-post skipped (rate limit)');
    this.lastRepost = now;
    const id = await this.d.port.post(CONFIG_CHANNEL_ID, await this.render());
    await this.d.state.set(CONFIG_CHANNEL_ID, id);
    await this.d.port.pin(CONFIG_CHANNEL_ID, id).catch((err: unknown) => this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'pinning the settings panel failed'));
  }
}

function modalOf(a: SettingsAction): ModalSpec {
  return {
    customId: `panel:${a.section}:${a.id}`,
    title: a.label.slice(0, MODAL_TITLE_MAX),
    inputs: a.fields.map((f) => ({ id: f.id, label: f.label.slice(0, MODAL_LABEL_MAX), style: f.style, required: f.required, maxLength: f.maxLength })),
  };
}
