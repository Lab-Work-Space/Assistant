import { createHash, randomBytes } from 'node:crypto';
import type { OutboundPayload } from '../agents/loop/payload.js';
import type { ActorRef } from '../company/types.js';
import type { Project } from '../db/repos/projects.js';
import type { ClaimedReleaseRow, Evidence, ReleaseRepo, ReleaseRow, ReleaseView } from '../db/repos/releases.js';
import { escapeCardText } from '../discord/embeds/approval.js';
import type { AuditFn } from '../governance/audit.js';
import { pluginText, validatePlugin } from '../forge/validate.js';
import type { ForgeRequestPort, PluginInfo } from '../forge/types.js';
import { screenText } from '../knowledge/screen.js';
import { SandboxError } from '../tools/plugins/workspace/sandbox.js';
import { WS_TEXT, WsError } from '../workspaces/errors.js';
import type { WsService } from '../workspaces/service.js';
import { FORGE_BUILDER_LINE, RELEASE_TARGETS, SANDBOX_LINE, type ClaimedRelease } from './targets.js';

/** `release_request {slug, title, summary}`: what the service needs of the validated tool input (the zod schema lives in the tool file). */
export interface ReleaseInput { slug: string; title: string; summary: string; target?: 'handoff' | 'install_plugin' }
/** Facts of the run, from code (the task row and the trigger), never from tool input. */
export interface RunInfo {
  tainted: boolean;
  task: { id: string; rootId: string; tainted: boolean } | null;
  ownsTask: boolean;
  source: { channelId: string; threadId: string | null } | null;
}

export const RELEASE_ZIP_MAX = 10_000_000;

export type FixedRequestCode = 'not_software' | 'halted' | 'off' | 'no_task' | 'no_source' | 'ws_off' | 'screen' | 'tree_pending' | 'dept_cap' | 'total_cap' | 'day_cap' | 'exception'
  | 'forge_off' | 'not_forge' | 'plugin_tainted' | 'forge_attempts' | 'forge_day_cap' | 'image_cap' | 'plugin_skipped' | 'plugin_slug_taken';
/** `plugin_<code>`: a validator code (forge/validate.ts), its text from `pluginText`. */
export type RequestCode = FixedRequestCode | `plugin_${string}`;
/** Fixed texts; nothing echoes input or model text. */
export const REQUEST_TEXT: Record<FixedRequestCode, string> = {
  not_software: 'Only the software head can request a release.',
  halted: 'The company is halted; try again after /resume.',
  off: 'Releases are switched off.',
  no_task: 'release_request works only inside a task you own.',
  no_source: 'There is no thread here to release into.',
  ws_off: 'Workspaces are switched off or not set up.',
  screen: 'The title or summary was refused (a secret-like value or control characters).',
  tree_pending: 'This task tree already has a release waiting for a decision.',
  dept_cap: 'Your department already has 2 releases waiting for a decision.',
  total_cap: 'There are already 5 releases waiting for a decision.',
  day_cap: 'Your department has requested 5 releases today; try again tomorrow.',
  exception: 'That could not be done now; nothing was changed.',
  forge_off: 'The plugin forge is switched off.',
  not_forge: 'install_plugin works only inside an active forge project.',
  plugin_tainted: 'A run that read outside content cannot request a plugin; ask again from a run that did not.',
  forge_attempts: 'This forge already had 3 builds.',
  forge_day_cap: '3 plugin builds were requested today; try again tomorrow.',
  image_cap: '8 built plugin images are kept already; a Bot Admin must disable unused servers.',
  plugin_skipped: 'Some workspace files could not be exported; a plugin must export completely.',
  plugin_slug_taken: 'That plugin slug is already used by an MCP server.',
};
export type Requested = { ok: true; id: number; text: string } | { ok: false; code: RequestCode; error: string };

export type DecideCode = 'wrong_card' | 'not_pending' | 'expired' | 'halted' | 'off' | 'not_found' | 'hash_mismatch' | 'post_failed' | 'post_unknown' | 'screen' | 'plugin_invalid' | 'not_forge' | 'exception';
export const DECIDE_TEXT: Record<DecideCode, string> = {
  wrong_card: 'That button does not belong to this card.',
  not_pending: 'Already decided.',
  expired: 'This release request has expired.',
  halted: 'The company is halted; approve after /resume.',
  off: 'Releases are switched off.',
  not_found: 'No release with that number.',
  hash_mismatch: 'The stored artefact does not match its sha256; nothing was released and the request was closed.',
  post_failed: 'The zip could not be posted in the task thread; nothing was released. Press Approve again or Reject.',
  post_unknown: 'The post could not be confirmed; check the task thread. Nothing more will be posted and the request was closed.',
  screen: 'The reason was refused (a secret-like value or control characters).',
  plugin_invalid: 'The stored plugin no longer passes the plugin rules; nothing was built and the request was closed.',
  not_forge: 'This plugin forge was cancelled or its project is no longer active; nothing was built. Reject this card.',
  exception: 'That could not be done now; nothing was changed.',
};
export const SETTLE_UNSETTLED_TEXT = 'The zip was posted, but the record could not be updated; it will be closed at the next restart.';
export const REASON_SCREEN = DECIDE_TEXT.screen;

export type DecideInput = { token: string; action: 'approve' | 'reject'; userId: string; channelId: string | null; messageId: string | null };
export type Decided = { ok: true; row: ReleaseRow; result: 'released' | 'rejected' } | { ok: false; code: DecideCode; text: string };

export interface ReleaseDeps {
  repo: Pick<ReleaseRepo, 'openCounts' | 'window' | 'evidence' | 'create' | 'setCard' | 'byToken' | 'byId' | 'claim' | 'revert' | 'settleReleased' | 'fail' | 'reject' | 'rejectById' | 'expire' | 'failInterrupted' | 'list' | 'now'>;
  ws: Pick<WsService, 'export'>;
  projects: { byRoot(rootId: string): Promise<Pick<Project, 'id' | 'title' | 'status' | 'tainted'> | null> };
  /** `release.enabled` and `ws.enabled`: read at each use; a throw counts as off (RL-C13). Only exactly `true` is on. */
  enabled: () => unknown;
  wsEnabled: () => unknown;
  halted: () => boolean;
  /** `schedule.timezone`, for the per-day cap. */
  tz: () => string;
  audit: AuditFn;
  /** The live literal secrets (the array grows at boot): read at each use. */
  secrets: readonly string[];
  configChannelId: string;
  catalogDigest: string;
  /** Posts the card as hq in #setting and returns the message id. */
  postCard: (p: OutboundPayload & { releaseCardId: string }) => Promise<string>;
  postFile: (actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, f: { name: string; data: Buffer; contentType: string; nonce?: string }) => Promise<string>;
  /** R7: a plain post (the install_plugin thread notice, with its nonce). */
  post: (actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, opts?: { nonce?: string }) => Promise<string>;
  /** R7: the forge's request-time reads and the enqueue closure. Absent means the forge is off. */
  forge?: ForgeRequestPort;
  provenance: { record(messageId: string, channelId: string, tainted: boolean, userId: string | null): Promise<void> };
  closeCard: (channelId: string, messageId: string, note: string) => Promise<void>;
  /** `Scheduler.notifyHead`: code text only (the one scoped exception is the Bot Admin's reject reason, RL-C10). */
  notifyHead: (dept: string, text: string) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
  newToken?: () => string;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');
const SNOWFLAKE = /^[0-9]{17,20}$/;
const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();
const sha16 = (s: string): string => s.slice(0, 16);
const root8 = (rootId: string): string => rootId.slice(0, 8);
const hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
/** An escaped value that must fit one embed field (1024): the cap shrinks until it does (escaping can double the length). */
const fit = (s: string, max: number, secrets: readonly string[], limit = 1000): string => {
  let m = max;
  let out = escapeCardText(s, m, secrets);
  while (out.length > limit && m > 20) { m -= 20; out = escapeCardText(s, m, secrets); }
  return out;
};

/** The card's evidence lines (RL-C4): what code recorded, and the honest caveat that a ws_run can itself change files. */
export function evidenceLines(ev: Evidence): string {
  if (ev.runs.length === 0) return 'No test run recorded for this workspace.';
  const lines = ev.runs.map((r) => {
    const unix = Math.floor(Date.parse(r.at) / 1000);
    const m = /^exit=(-?\d+)$/.exec(r.result);
    return `- ws_run ${r.verb}: ${m ? `exit ${m[1]}` : r.result} (<t:${unix}:f>)`;
  });
  lines.push(`ws_write/ws_delete after the last run: ${ev.writesAfterLastRun ? 'yes' : 'no'}. A ws_run can itself change files.`);
  return lines.join('\n');
}

/**
 * R5 RELEASE-1. A software head asks for a release of one workspace; code zips it, pins the bytes, reads the recorded evidence and posts a card in #setting; a
 * live Bot Admin approves or rejects on the card and the pinned bytes are posted in the task thread. This module never imports the AI approver, autopilot or
 * a judge (RL-C1: the allowlist test pins what it may import and who may import it). The tool receives a closure with `request` only.
 */
export class ReleaseService {
  constructor(private readonly d: ReleaseDeps) {}

  private async rec(actor: string, action: string, outcome: string, taskId?: string | null): Promise<void> {
    await this.d.audit({ actor, action, tool: 'release_request', outcome, ...(taskId ? { taskId } : {}) });
  }

  private on(read: () => unknown): boolean {
    try {
      return read() === true;
    } catch {
      return false; // a read error is off (RL-C13)
    }
  }

  private async refuse(who: string, code: RequestCode, taskId?: string | null, detail?: string, text?: string): Promise<Requested> {
    await this.rec(who, 'release.request', `refused:${detail ?? code}`, taskId);
    return { ok: false, code, error: text ?? REQUEST_TEXT[code as FixedRequestCode] };
  }

  async request(actor: ActorRef, run: RunInfo, input: ReleaseInput): Promise<Requested> {
    const who = actor.kind === 'head' ? `head:${actor.dept}` : `persona:${actor.personaId}`.slice(0, 80);
    const taskId = run.task?.id ?? null;
    if (actor.kind !== 'head' || actor.dept !== 'software') return this.refuse(who, 'not_software', taskId); // Praw's "*" is also refused: the manifest limits the name to software too (RL-C7)
    if (this.d.halted()) return this.refuse(who, 'halted', taskId);
    if (!this.on(this.d.enabled)) return this.refuse(who, 'off', taskId);
    if (!run.task || !run.ownsTask) return this.refuse(who, 'no_task', taskId);
    if (!run.source || !SNOWFLAKE.test(run.source.channelId) || (run.source.threadId !== null && !SNOWFLAKE.test(run.source.threadId))) return this.refuse(who, 'no_source', taskId);
    if (!this.on(this.d.wsEnabled)) return this.refuse(who, 'ws_off', taskId);
    const secrets = this.d.secrets;
    const title = screenText(fold(input.title), { max: 100, secrets, multiline: false });
    const summary = screenText(fold(input.summary), { max: 600, secrets, multiline: false });
    if (!title.ok || !summary.ok) return this.refuse(who, 'screen', taskId);
    const task = run.task;
    const source = run.source;
    try {
      const dept = actor.dept;
      const tz = this.d.tz();
      // R7 (spec 3.3 steps 8a-8c, PF-C7): the forge gates come after the R5 steps 1-7 and before the R5 counts and the export. Read-only.
      const plugin = input.target === 'install_plugin';
      let forge: { id: number; ideaId: number; ideaName: string; deptId: string } | null = null;
      let pluginProject: Pick<Project, 'id' | 'title' | 'status' | 'tainted'> | null = null;
      if (plugin) {
        const port = this.d.forge;
        if (!port || !this.on(() => port.enabled())) return this.refuse(who, 'forge_off', taskId);
        pluginProject = await this.d.projects.byRoot(task.rootId);
        const f = pluginProject && pluginProject.status === 'active' ? await port.forgeOf(pluginProject.id) : null;
        if (!f || f.status !== 'live') return this.refuse(who, 'not_forge', taskId);
        if (run.tainted || task.tainted || pluginProject!.tainted) return this.refuse(who, 'plugin_tainted', taskId); // PF-C7: a tainted turn cannot request a permanent tool; G2-FG-12: nor from a project a tainted run proposed (its goal reaches this run as task context)
        const cap = await port.capCode(f.id, tz);
        if (cap !== null) return this.refuse(who, cap, taskId);
        forge = f;
      }
      const counts = await this.d.repo.openCounts(dept, task.rootId, tz);
      if (counts.tree >= 1) return this.refuse(who, 'tree_pending', taskId);
      if (counts.dept >= 2) return this.refuse(who, 'dept_cap', taskId);
      if (counts.total >= 5) return this.refuse(who, 'total_cap', taskId);
      if (counts.today >= 5) return this.refuse(who, 'day_cap', taskId);
      // step 9: the first side effect. The secrets are read now (the array grows at boot).
      let exp: Awaited<ReturnType<WsService['export']>>;
      try {
        exp = await this.d.ws.export(input.slug, [...secrets]);
      } catch (err) {
        if (err instanceof WsError) { await this.rec(who, 'release.request', `refused:ws_${err.code.toLowerCase()}`, taskId); return { ok: false, code: 'exception', error: err.message }; }
        if (err instanceof SandboxError) { await this.rec(who, 'release.request', 'refused:sandbox', taskId); return { ok: false, code: 'exception', error: err.message }; }
        throw err;
      }
      if (exp.zip.length > RELEASE_ZIP_MAX) { await this.rec(who, 'release.request', 'refused:ws_e_export_size', taskId); return { ok: false, code: 'exception', error: WS_TEXT.E_EXPORT_SIZE }; }
      let info: PluginInfo | null = null;
      if (plugin) {
        if (exp.skipped > 0) return this.refuse(who, 'plugin_skipped', taskId);
        const v = validatePlugin(exp.zip, { forgeIdeaId: forge!.ideaId, secrets: [...secrets], canonical: true });
        if (!v.ok) return this.refuse(who, `plugin_${v.code}`, taskId, undefined, pluginText(v.code, v.first));
        if (await this.d.forge!.slugTaken(v.info.forge.slug, forge!.id)) return this.refuse(who, 'plugin_slug_taken', taskId);
        info = v.info;
      }
      // RL-C4: the evidence window is taken right after the export (the write lock was held until now) and bound to the workspace's current life
      const win = await this.d.repo.window(input.slug);
      if (win.since === null) return this.refuse(who, 'exception', taskId);
      const evidence = await this.d.repo.evidence(input.slug, win.since, win.until);
      const project = plugin ? pluginProject : await this.d.projects.byRoot(task.rootId);
      const token = (this.d.newToken ?? (() => randomBytes(16).toString('hex')))();
      const made = await this.d.repo.create({
        token, deptId: dept, requester: `head:${dept}`, taskId: task.id, rootId: task.rootId, projectId: project?.id ?? null, target: plugin ? 'install_plugin' : 'handoff', title: title.text, summary: summary.text, slug: input.slug,
        sha256: exp.sha256, bytes: exp.zip.length, files: exp.files, skipped: exp.skipped, zip: exp.zip, evidence, tainted: run.tainted || task.tainted, catalogDigest: this.d.catalogDigest,
        sourceChannelId: source.channelId, sourceThreadId: source.threadId,
        ...(plugin ? { forgeId: forge!.id, pluginSlug: info!.forge.slug, pluginManifestSha256: info!.manifestSha256 } : {}),
      }, tz);
      if (!made.ok) return this.refuse(who, made.code, taskId);
      await this.rec(who, 'release.request', `#${made.id} ${input.slug} ${sha16(exp.sha256)}`, taskId);
      let cardOk = true;
      let noCopy = false;
      try {
        const copy = await this.postCopy(made.id, input.slug, exp);
        if (plugin && !copy) { noCopy = true; throw new Error('copy'); } // PF-C14: a plugin card never exists without the source copy above it
        const messageId = await this.d.postCard({
          type: 'approval', origin: 'governance', title: 'Release request', releaseCardId: token,
          body: this.cardBody({ id: made.id, title: title.text, slug: input.slug, exp, project, rootId: task.rootId, tainted: run.tainted || task.tainted, copy, expiresAt: made.expiresAt, ...(plugin ? { plugin: { info: info!, forge: forge!, mcpOn: this.on(() => this.d.forge!.mcpEnabled()), base: this.d.forge!.baseId } } : {}) }),
          fields: [
            { name: 'Summary (written by the bot, untrusted)', value: fit(summary.text, 600, secrets) },
            { name: "Evidence (recorded by code; each verb runs the workspace's own bot-written scripts)", value: evidenceLines(evidence) },
            ...(plugin ? this.pluginFields(info!, secrets) : []),
          ],
        });
        await this.d.repo.setCard(made.id, this.d.configChannelId, messageId);
      } catch (err) {
        cardOk = false; // the row stays pending without a card: listed in /release list, expires in 7 days
        if (!noCopy) this.d.log.error({ errName: errName(err) }, 'release card post failed');
      }
      if (plugin) {
        return {
          ok: true, id: made.id,
          text: `Release request #${made.id} for plugin ${info!.forge.slug} was filed (${info!.shipped.length} shipped file(s), ${exp.zip.length} bytes, sha256 ${sha16(exp.sha256)}). NOTHING is built or installed yet; a Bot Admin approves the build, and code then stages it for a second Bot Admin step. Do not say it is built or installed.${cardOk ? '' : noCopy ? ' The source copy could not be posted, so no card was posted and nothing can be approved; the request expires in 7 days or a Bot Admin can reject it with /release reject.' : ' The card could not be posted; a Bot Admin can see it in /release list.'}`,
        };
      }
      return {
        ok: true, id: made.id,
        text: `Release request #${made.id} for ${input.slug} was sent to the Bot Admins (${exp.files} file(s), ${exp.zip.length} bytes, sha256 ${sha16(exp.sha256)}). NOTHING is released yet; you will be told in your room. Do not say it is released, and do not push or publish it with other tools.${cardOk ? '' : ' The card could not be posted; a Bot Admin can see it in /release list.'}`,
      };
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'release request failed');
      return this.refuse(who, 'exception', taskId).catch(() => ({ ok: false as const, code: 'exception' as const, error: REQUEST_TEXT.exception }));
    }
  }

  /** The artefact copy, posted as hq in #setting from the pinned Buffer (RL-C9). Returns false when it could not be posted; never throws. */
  private async postCopy(id: number, slug: string, exp: { zip: Buffer; files: number; sha256: string }): Promise<boolean> {
    try {
      const messageId = await this.d.postFile({ kind: 'head', dept: 'hq' }, { channelId: this.d.configChannelId }, {
        type: 'chat', body: `Release #${id} artefact for review: ${slug}, ${exp.files} file(s), ${exp.zip.length} bytes, sha256 ${exp.sha256}. Written by bots and container code; open with care. ${SANDBOX_LINE}`,
      }, { name: `${slug}-release-${id}.zip`, data: exp.zip, contentType: 'application/zip' });
      await this.d.provenance.record(messageId, this.d.configChannelId, true, null).catch(() => undefined); // container-written bytes: always tainted
      return true;
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'release artefact copy post failed');
      return false;
    }
  }

  private cardBody(c: { id: number; title: string; slug: string; exp: { zip: Buffer; files: number; sha256: string; skipped: number }; project: Pick<Project, 'id' | 'title' | 'status'> | null; rootId: string; tainted: boolean; copy: boolean; expiresAt: Date; plugin?: { info: PluginInfo; forge: { id: number; ideaId: number; ideaName: string; deptId: string }; mcpOn: boolean; base: string | null } }): string {
    const s = this.d.secrets;
    if (c.plugin) {
      const { info, forge } = c.plugin;
      const bytes = info.shipped.reduce((n, f) => n + f.size, 0);
      return [
        `**${escapeCardText(c.title, 100, s)}**`,
        `Release #${c.id} from the software head. Target: install_plugin (code builds an MCP server image from these exact bytes and stages it; nothing is installed until a Bot Admin runs /mcp approve after seeing the tools the built server reports).`,
        `Project of the requesting task: ${c.project ? `Project #${c.project.id} ${escapeCardText(c.project.title, 60, s)} (${c.project.status})` : `none (task tree ${root8(c.rootId)})`}.`,
        `Forge #${forge.id} for tool idea #${forge.ideaId} ${escapeCardText(forge.ideaName, 40, s)} from ${escapeCardText(forge.deptId, 32, s)}.`,
        `Plugin ${escapeCardText(info.forge.slug, 16, s)} "${escapeCardText(info.forge.title, 80, s)}": ${info.shipped.length} shipped file(s), ${bytes} bytes, manifest ${info.manifestSha256.slice(0, 16)}; ${info.otherCount} other file(s) (tests, notes) are not shipped.`,
        `Runtime dependencies: none. Class: write (every call asks a Bot Admin). Departments: ${escapeCardText(forge.deptId, 32, s)}. Network: none. Secrets: none.`,
        FORGE_BUILDER_LINE(c.plugin.base),
        `External tools are switched ${c.plugin.mcpOn ? 'on' : 'off'} (mcp.enabled); staging works either way.`,
        `Artefact: workspace ${c.slug}, ${c.exp.files} file(s), ${c.exp.zip.length} bytes, sha256 ${c.exp.sha256}.`,
        'Pinned: these exact bytes are stored; Approve builds exactly them even if the workspace changes later.',
        'The files were written by bots and container code.',
        'Whether earlier runs that wrote these files read outside content is not tracked.',
        SANDBOX_LINE,
        c.copy ? 'Artefact copy: posted just above this card.' : 'Artefact copy: could not be posted here.',
        `Tool catalog ${this.d.catalogDigest.slice(0, 16)}.`,
        `Expires <t:${Math.floor(c.expiresAt.getTime() / 1000)}:R>.`,
      ].join('\n');
    }
    return [
      `**${escapeCardText(c.title, 100, s)}**`,
      `Release #${c.id} from the software head. Target: handoff (post the zip in the task thread and mark it released).`,
      `Project of the requesting task: ${c.project ? `Project #${c.project.id} ${escapeCardText(c.project.title, 60, s)} (${c.project.status})` : `none (task tree ${root8(c.rootId)})`}. The workspace is not linked to a project.`,
      `Artefact: workspace ${c.slug}, ${c.exp.files} file(s), ${c.exp.zip.length} bytes, sha256 ${c.exp.sha256}.${c.exp.skipped > 0 ? ` ${c.exp.skipped} entr${c.exp.skipped === 1 ? 'y' : 'ies'} skipped (not exportable).` : ''}`,
      'Pinned: these exact bytes are stored; Approve releases them even if the workspace changes later.',
      'The files were written by bots and container code.',
      c.tainted ? 'The requesting run read outside content (tainted). Review the files before approving.' : 'Whether earlier runs that wrote these files read outside content is not tracked.',
      SANDBOX_LINE,
      c.copy ? 'Artefact copy: posted just above this card.' : 'Artefact copy: could not be posted here.',
      `Tool catalog ${this.d.catalogDigest.slice(0, 16)}.`,
      `Expires <t:${Math.floor(c.expiresAt.getTime() / 1000)}:R>.`,
    ].join('\n');
  }

  /** The two extra fields of an install_plugin card (spec 5.6): what code will ship, and the dev dependencies that never ship. Each is fitted to one embed field. */
  private pluginFields(info: PluginInfo, secrets: readonly string[]): { name: string; value: string }[] {
    const line = (f: { path: string; size: number; sha256: string }): string => `- ${escapeCardText(f.path, 200, secrets)} (${f.size} B, ${f.sha256.slice(0, 12)})`;
    let shown = Math.min(info.shipped.length, 20);
    const render = (n: number): string => [...info.shipped.slice(0, n).map(line), ...(info.shipped.length > n ? [`… and ${info.shipped.length - n} more (see the artefact copy)`] : [])].join('\n');
    let files = render(shown);
    while (files.length > 800 && shown > 0) { shown -= 1; files = render(shown); }
    let devShown = info.devDeps.length;
    const dev = (n: number): string => (info.devDeps.length === 0 ? 'none' : [...info.devDeps.slice(0, n).map((d) => `${escapeCardText(d.name, 80, secrets)}@${escapeCardText(d.version, 40, secrets)}`), ...(info.devDeps.length > n ? [`… and ${info.devDeps.length - n} more`] : [])].join('\n'));
    let devText = dev(devShown);
    while (devText.length > 600 && devShown > 0) { devShown -= 1; devText = dev(devShown); }
    return [
      { name: 'Shipped files (listed by code: path, bytes, sha256 first 12)', value: files || 'none' },
      { name: 'Dev dependencies (not shipped; workspace tests only)', value: devText },
    ];
  }

  // ---- the button ----

  async decide(c: DecideInput): Promise<Decided> {
    const no = (code: DecideCode): Decided => ({ ok: false, code, text: DECIDE_TEXT[code] });
    try {
      if (!/^[0-9a-f]{32}$/.test(c.token)) return no('wrong_card');
      const row = await this.d.repo.byToken(c.token);
      // the stored card is the only card this token may be decided from, and it is in #setting
      if (!row || row.messageId === null || row.channelId === null || row.channelId !== c.channelId || row.messageId !== c.messageId || c.channelId !== this.d.configChannelId) return no('wrong_card');
      if (row.status !== 'pending') return no('not_pending');
      if (!row.live) return no('expired');
      if (c.action === 'reject') {
        const done = await this.d.repo.reject(c.token, c.userId, null);
        if (!done) return no('not_pending');
        return await this.afterReject(done, c.userId, null);
      }
      if (this.d.halted()) return no('halted'); // the row stays pending
      if (!this.on(this.d.enabled)) return no('off'); // so does an unreadable switch
      if (row.target === 'install_plugin' && !this.on(() => this.d.forge?.enabled())) return no('off'); // R7: the forge switch, before the claim; the row stays pending
      if (row.target === 'install_plugin' && !(await this.forgeOpen(row))) return no('not_forge'); // G2-FG-09: before the claim, so the row stays pending (it expires or is rejected), never released
      const claimed = await this.d.repo.claim(c.token, c.userId);
      if (!claimed) return no('not_pending');
      return await this.release(claimed, c.userId);
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'release decide failed');
      return no('exception');
    }
  }

  /** G2-FG-09: the card's forge is still `live` or `staged` (the one of its project, the one the row names) and the project is active. Any read error counts as not open. */
  private async forgeOpen(row: Pick<ReleaseRow, 'forgeId' | 'projectId' | 'rootId'>): Promise<boolean> {
    try {
      const port = this.d.forge;
      if (!port || row.forgeId === null || row.projectId === null) return false;
      const project = await this.d.projects.byRoot(row.rootId);
      if (!project || project.id !== row.projectId || project.status !== 'active') return false;
      const f = await port.forgeOf(row.projectId);
      return f !== null && f.id === row.forgeId && (f.status === 'live' || f.status === 'staged');
    } catch {
      return false;
    }
  }

  /** `/release reject id reason` (a Bot Admin in #setting, checked by the command layer): the screened reason is stored and shown to the head (RL-C10, a scoped exception). */
  async reject(c: { id: number; userId: string; reason: string }): Promise<Decided> {
    const no = (code: DecideCode): Decided => ({ ok: false, code, text: DECIDE_TEXT[code] });
    try {
      const screened = screenText(c.reason.replace(/[ \t]+/g, ' ').trim(), { max: 200, secrets: this.d.secrets, multiline: false });
      if (!screened.ok) return { ok: false, code: 'screen', text: REASON_SCREEN };
      const row = await this.d.repo.byId(c.id);
      if (!row) return no('not_found');
      const done = await this.d.repo.rejectById(c.id, c.userId, screened.text);
      if (!done) return no('not_pending');
      return await this.afterReject(done, c.userId, screened.text);
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'release reject failed');
      return no('exception');
    }
  }

  private async afterReject(row: ReleaseRow, userId: string, reason: string | null): Promise<Decided> {
    await this.rec(`user:${userId}`, 'release.decide', `#${row.id} rejected`, row.taskId);
    await this.after(row,
      reason === null ? `Rejected by <@${userId}>. Nothing was released.` : `Rejected by <@${userId}> with a reason. Nothing was released.`,
      `Release #${row.id} (${row.slug}) was rejected by a Bot Admin. Nothing was released.${reason === null ? '' : ` Reason from a Bot Admin: "${reason}"`}`);
    return { ok: true, row, result: 'rejected' };
  }

  /** The claimed row (releasing, the zip in hand). The post is made once; a certain refusal reverts, anything unknown fails the row (RL-C3). */
  private async release(row: ClaimedReleaseRow, userId: string): Promise<Decided> {
    const by = `user:${userId}`;
    try {
      if (hex(row.zip) !== row.sha256 || row.zip.length !== row.bytes) {
        await this.d.repo.fail(row.id, 'hash_mismatch');
        await this.rec(by, 'release.decide', `#${row.id} failed:hash_mismatch`, row.taskId);
        await this.after(row, 'Closed: the stored artefact did not match its sha256. Nothing was released.', `Release #${row.id} (${row.slug}) was closed: the stored artefact did not match its sha256. Nothing was released.`);
        return { ok: false, code: 'hash_mismatch', text: DECIDE_TEXT.hash_mismatch };
      }
      const claimed: ClaimedRelease = { id: row.id, deptId: row.deptId, slug: row.slug, title: row.title, summary: row.summary, sha256: row.sha256, bytes: row.bytes, files: row.files, sourceChannelId: row.sourceChannelId, sourceThreadId: row.sourceThreadId, zip: row.zip,
        forgeId: row.forgeId, pluginSlug: row.pluginSlug, pluginManifestSha256: row.pluginManifestSha256, decidedBy: row.decidedBy };
      const forge = this.d.forge;
      const res = await RELEASE_TARGETS[row.target](claimed, {
        postFile: (a, t, p, f) => this.d.postFile(a, t, p, f), post: (a, t, p, o) => this.d.post(a, t, p, o),
        forge: async (b) => (forge ? forge.enqueue(b) : { ok: false, code: 'exception' }), secrets: this.d.secrets,
      });
      if (!res.ok) {
        this.d.log.error({ errName: res.errName }, 'release post failed');
        if (res.fail === 'plugin_invalid') { // the stored plugin no longer passes the rules: closed, never reverted
          await this.d.repo.fail(row.id, 'plugin_invalid');
          await this.rec(by, 'release.decide', `#${row.id} failed:plugin_invalid`, row.taskId);
          await this.after(row, 'Closed: the stored plugin no longer passes the plugin rules. Nothing was built.', `Release #${row.id} (${row.slug}) was closed: the stored plugin no longer passes the plugin rules. Nothing was built or installed.`);
          return { ok: false, code: 'plugin_invalid', text: DECIDE_TEXT.plugin_invalid };
        }
        if (res.certain) {
          await this.d.repo.revert(row.id); // Discord certainly refused: nothing was released, the admin may press Approve again or Reject
          return { ok: false, code: 'post_failed', text: DECIDE_TEXT.post_failed };
        }
        await this.d.repo.fail(row.id, 'post_unknown'); // the message may exist: never re-posted
        await this.rec(by, 'release.decide', `#${row.id} failed:post_unknown`, row.taskId);
        await this.after(row, 'Release failed: could not confirm the post; check the task thread. Nothing more will be posted.',
          `Release #${row.id} (${row.slug}): could not confirm the post; check the task thread before asking again. Nothing more will be posted.`);
        return { ok: false, code: 'post_unknown', text: DECIDE_TEXT.post_unknown };
      }
      // the zip's content was written by container code: the post is always recorded tainted
      await this.d.provenance.record(res.messageId, row.sourceThreadId ?? row.sourceChannelId, true, null).catch(() => undefined);
      try {
        await this.d.repo.settleReleased(row.id, res.messageId);
      } catch (err) {
        this.d.log.error({ errName: errName(err) }, 'release settle failed');
        return { ok: false, code: 'exception', text: SETTLE_UNSETTLED_TEXT }; // the row stays releasing: recover(bootTime) closes it; it is never re-posted
      }
      await this.rec(by, 'release.decide', `#${row.id} released ${sha16(row.sha256)}`, row.taskId);
      if (row.target === 'install_plugin') {
        await this.after(row, `Approved by <@${userId}>. Code will build plugin ${row.pluginSlug} (sha256 ${sha16(row.sha256)}) and stage it. It is NOT installed until a Bot Admin runs /mcp approve.`,
          `Release #${row.id} (${row.slug}) was approved by a Bot Admin: code will build the plugin and stage it. It is NOT installed yet; do not say it is installed. You will be told when it is staged.`);
        return { ok: true, row, result: 'released' };
      }
      const next = row.projectId !== null
        ? ` Project #${row.projectId}: if its work is finished, close it with /project close id:${row.projectId}.`
        : ` Root task ${root8(row.rootId)}: when its work is finished it can be accepted with /task done.`;
      await this.after(row, `Released by <@${userId}>. Posted in the task thread (sha256 ${sha16(row.sha256)}).${next}`,
        `Release #${row.id} (${row.slug}) was approved by a Bot Admin and posted in the task thread. You may now report it as released; if this finishes the task, mark it done.`);
      return { ok: true, row, result: 'released' };
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'release approve failed');
      return { ok: false, code: 'exception', text: DECIDE_TEXT.exception }; // after the claim: left releasing for recover(bootTime); never reverted on an unknown fault
    }
  }

  /** Closes the card and tells the head in its room. Each step is independent and never throws. */
  private async after(row: Pick<ReleaseView, 'channelId' | 'messageId' | 'deptId'>, cardNote: string, headText: string): Promise<void> {
    if (row.channelId && row.messageId) await this.d.closeCard(row.channelId, row.messageId, cardNote).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'release card close failed'));
    await this.d.notifyHead(row.deptId, headText).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'release head notice failed'));
  }

  // ---- expiry and boot ----

  /** Every 60 s and once at boot: expire, close the card, tell the head. Never throws. */
  async sweep(): Promise<number> {
    try {
      const rows = await this.d.repo.expire();
      for (const r of rows) {
        await this.rec('system:release', 'release.expire', `#${r.id} ${r.slug}`, r.taskId);
        await this.after(r, 'Expired after 7 days without a decision.', `Release #${r.id} (${r.slug}) expired after 7 days without a decision. Nothing was released.`);
      }
      return rows.length;
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'release sweep failed');
      return 0;
    }
  }

  /** The database clock, to be read BEFORE the Discord clients come up and passed to `recover` (RL-C5). */
  bootTime(): Promise<string> {
    return this.d.repo.now();
  }

  /** RL-C5 (boot): a claim older than `bootTime` whose process died is marked failed (interrupted). It NEVER re-posts. Never throws. */
  async recover(bootTime: string): Promise<void> {
    try {
      for (const r of await this.d.repo.failInterrupted(bootTime)) {
        await this.rec('system:release', 'release.decide', `#${r.id} failed:interrupted`, r.taskId);
        await this.after(r, 'Interrupted during the release (restart). Check the task thread; nothing more will be posted.', `Release #${r.id} (${r.slug}) was interrupted by a restart; check the task thread before asking again.`);
      }
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'release recovery failed');
    }
  }

  list(limit = 25): Promise<ReleaseView[]> {
    return this.d.repo.list(limit);
  }

  show(id: number): Promise<ReleaseView | null> {
    return this.d.repo.byId(id);
  }
}

/**
 * G2-RL-03: what the command layer (`/release`, the `relcard:` route) gets: four closures, not the service, so nothing else on it (request, sweep, recover,
 * bootTime) and no prototype method is reachable through CommandDeps or the AI-driven admin console.
 */
export function releaseCommandDeps(s: Pick<ReleaseService, 'decide' | 'list' | 'show' | 'reject'>): Pick<ReleaseService, 'decide' | 'list' | 'show' | 'reject'> {
  return { decide: (c) => s.decide(c), list: (n) => s.list(n), show: (id) => s.show(id), reject: (c) => s.reject(c) };
}

/** G2-RL-04: what the AI digest gets: the day counts and nothing else of the repo. */
export function releaseDigestDeps(r: Pick<ReleaseRepo, 'day'>): Pick<ReleaseRepo, 'day'> {
  return { day: (tz) => r.day(tz) };
}
