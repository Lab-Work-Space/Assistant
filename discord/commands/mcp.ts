import type { AddInput, AdminView, Fail } from '../../mcp/admin.js';
import { escapeCardText } from '../embeds/approval.js';
import { configReply, ephemeral, type Handler, type InteractionLike, type Reply } from './types.js';

/**
 * R6 MCP-1 `/mcp` (spec 5.10, Gate 1 MC-C7, MC-C16). Bot Admin in #setting only: `decide()` in commands/index.ts already checked the guild, the channel and this
 * interaction's live admin role, the same guard as `/release`. Every reply is ephemeral with no pings. The admin's view is exactly what the model sees (the
 * description template and the JSON schema), escaped as a card is, URLs defanged, never cut: it is paged, and every page carries both hashes.
 * Nothing here echoes a refusal's input; a refusal is the fixed text the admin module returns.
 */
const NO_MCP = ephemeral('MCP is not available.');
const CHUNK = 1500;
const ZW = '​';

/** Escaped like a card (mentions, markdown, masked links, fences, invisible characters), then URLs and bare `www.` hosts defanged. */
const esc = (s: string, secrets: readonly string[]): string => escapeCardText(s, 1_000_000, secrets).replace(/:\/\//g, `:/${ZW}/`).replace(/\bwww\./gi, `www${ZW}.`);

/** One page reply: ephemeral, no pings, no link previews (a message with embeds suppressed). */
const page = (content: string): Reply => ({ ...ephemeral(content), suppressEmbeds: true });

/** Splits escaped text on newlines where it can and never leaves an escape (`\`) dangling at the end of a piece. Nothing is dropped. */
export function paginate(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    let piece = rest.slice(0, cut);
    const tail = /\\+$/.exec(piece)?.[0].length ?? 0;
    if (tail % 2 === 1) { piece = piece.slice(0, -1); cut -= 1; }
    out.push(piece);
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}

/** The body the admin reviews, escaped: what the model is shown for each tool (name, description, input schema) plus the display-only fields. */
export function viewBody(v: AdminView, secrets: readonly string[]): string {
  const lines = [
    `**${esc(v.title, secrets)}** (server ${v.slug}, ${v.class} class, ${v.status}). Departments: ${v.depts.map((d) => esc(d, secrets)).join(', ') || '-'}.`,
    `Image ${esc(v.imageId, secrets)}${v.imageRef ? `, ref ${esc(v.imageRef, secrets)}` : ''}. ${v.toolCount} tool(s). Everything below was written by the server and is untrusted.`,
  ];
  for (const t of v.tools) lines.push('', `**${esc(t.name, secrets)}**`, esc(t.description, secrets), `Input schema: ${esc(JSON.stringify(t.schema), secrets)}`);
  return lines.join('\n');
}

/** Page `n` (1-based) of a view; null when out of range. Every page repeats the snapshot hash and the approve token; a pending server's last line is the approve command. */
export function viewPage(v: AdminView, secrets: readonly string[], n: number): { reply: Reply; pages: number } | null {
  const pieces = paginate(viewBody(v, secrets));
  if (!Number.isInteger(n) || n < 1 || n > pieces.length) return null;
  const head = `**MCP ${v.slug}** page ${n}/${pieces.length} - snapshot ${v.hash12} - approve token ${v.config12}`;
  const foot = v.status === 'pending' ? `\n${v.approveLine}${pieces.length > 1 ? ` (/mcp show slug:${v.slug} page:N for the other pages)` : ''}` : '';
  return { reply: page(`${head}\n${pieces[n - 1]}${foot}`), pages: pieces.length };
}

const fail = (f: Fail): Reply => ephemeral(f.text);
const slugOf = (i: InteractionLike): string => (i.options.string('slug') ?? '').trim();
const by = (i: InteractionLike) => ({ kind: 'admin' as const, userId: i.userId });

export const mcpList: Handler = async (_i, deps) => {
  if (!deps.mcp) return NO_MCP;
  const rows = await deps.mcp.list();
  if (!rows.length) return configReply('MCP servers', 'No MCP servers yet. Add one with /mcp add.', { ephemeral: true });
  const secrets = deps.secrets ?? [];
  return configReply('MCP servers', `${rows.length} server(s). Details: /mcp show.`, {
    ephemeral: true,
    fields: rows.slice(0, 25).map((r) => ({
      name: `${r.slug} (${r.status}, ${r.class})`.slice(0, 256),
      value: `${esc(r.title, secrets) || '-'} - ${Math.trunc(r.tools)} tool(s), departments ${r.depts.map((d) => esc(d, secrets)).join(', ') || '-'}, snapshot ${r.hash12}`.slice(0, 1024),
    })),
  });
};

export const mcpShow: Handler = async (i, deps) => {
  if (!deps.mcp) return NO_MCP;
  const r = await deps.mcp.show(slugOf(i));
  if (!r.ok) return fail(r);
  const n = i.options.integer('page') ?? 1;
  const p = viewPage(r.view, deps.secrets ?? [], n);
  if (!p) return ephemeral(`No such page (this view has ${paginate(viewBody(r.view, deps.secrets ?? [])).length}).`);
  return p.reply;
};

export const mcpAdd: Handler = async (i, deps) => {
  if (!deps.mcp) return NO_MCP;
  const s = (n: string): string | null => i.options.string(n);
  const input: AddInput = { slug: s('slug') ?? '', image: s('image') ?? '', departments: s('departments') ?? '', title: s('title') ?? '' };
  const opt = { class: s('class'), command: s('command'), env: s('env'), ref: s('ref') };
  for (const [k, v] of Object.entries(opt)) if (v !== null) (input as unknown as Record<string, unknown>)[k] = v;
  const timeout = i.options.integer('timeout');
  const daily = i.options.integer('daily');
  if (timeout !== null) input.timeout = timeout;
  if (daily !== null) input.daily = daily;
  const r = await deps.mcp.add(input, by(i));
  if (!r.ok) return fail(r);
  return viewPage(r.view, deps.secrets ?? [], 1)?.reply ?? ephemeral('Added, but the view could not be shown. Use /mcp show.');
};

export const mcpApprove: Handler = async (i, deps) => {
  if (!deps.mcp) return NO_MCP;
  const slug = slugOf(i);
  const token = (i.options.string('hash') ?? '').trim();
  if (!slug || !token) return ephemeral('Give the server name (slug) and the hash from /mcp add or /mcp show.');
  const r = await deps.mcp.approve({ slug, token }, by(i));
  return r.ok ? ephemeral(`Approved: ${esc(r.slug, [])} is active (token ${r.cfg12}). Grant it to departments with /mcp depts if needed, and turn on mcp.enabled in /settings.`) : fail(r);
};

export const mcpTest: Handler = async (i, deps) => {
  if (!deps.mcp) return NO_MCP;
  const r = await deps.mcp.test(slugOf(i), by(i));
  if (!r.ok) return fail(r);
  return ephemeral(r.result === 'ok' ? 'The server matches its approved snapshot.' : 'The server does not match its approved snapshot. It is not quarantined by this test; re-add it to review the change.');
};

export const mcpDisable: Handler = async (i, deps) => {
  if (!deps.mcp) return NO_MCP;
  const slug = slugOf(i);
  const r = await deps.mcp.disable(slug, by(i));
  return r.ok ? ephemeral(`Server ${esc(slug, [])} is disabled. Calls in flight finish; no new call starts.`) : fail(r);
};

export const mcpDepts: Handler = async (i, deps) => {
  if (!deps.mcp) return NO_MCP;
  const slug = slugOf(i);
  const departments = (i.options.string('departments') ?? '').trim();
  if (!departments) return ephemeral('Give the departments as a comma separated list of department ids.');
  const r = await deps.mcp.depts(slug, departments, by(i));
  return r.ok ? ephemeral(`Server ${esc(slug, [])} is now granted to: ${esc(departments, deps.secrets ?? [])}.`) : fail(r);
};
