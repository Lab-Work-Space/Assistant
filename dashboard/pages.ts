import { redactText } from '../core/logger.js';
import type { AdminCard } from '../db/repos/adminCards.js';
import type { AuditRow } from '../db/repos/ledger.js';
import type { SettingsAction, SettingsRegistry } from '../admin/settings.js';
import { SECTIONS } from '../admin/settings.js';
import { esc, html, raw, type SafeHtml } from './html.js';
import { GROUPS, keyNote, type EnvGroup } from './envfile.js';
import type { DevJob } from '../db/repos/devjobs.js';
import type { KnowledgeOverview } from '../knowledge/dashboard.js';
import type { SpendView } from '../governance/spend/spend.js';

export const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1f23;--card:#fff;--line:#d9dde3;--acc:#2563eb;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--card:#1d2026;--line:#2e333b;--acc:#60a5fa;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;padding:.6rem 1rem;background:var(--card);border-bottom:1px solid var(--line)}
header nav{display:flex;flex-wrap:wrap;gap:.25rem .9rem;flex:1}header a{color:var(--acc);text-decoration:none}header form{display:inline}
main{max-width:60rem;margin:0 auto;padding:1rem}h1{font-size:1.4rem;margin:.2rem 0 1rem}h2{font-size:1.1rem;margin:1.4rem 0 .5rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:.8rem 1rem;margin:.6rem 0}
table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
label{display:block;margin:.4rem 0 .1rem;font-size:.9rem}input,textarea,select,button{font:inherit;padding:.45rem .6rem;border:1px solid var(--line);border-radius:.4rem;background:var(--bg);color:var(--fg);max-width:100%}
input,textarea{width:100%}button{background:var(--acc);color:#fff;border:0;cursor:pointer;margin-top:.5rem}button.sec{background:transparent;color:var(--acc);border:1px solid var(--acc)}button.bad{background:var(--bad)}
.muted{opacity:.7}.warn{color:var(--warn)}.bad{color:var(--bad)}code{font-family:ui-monospace,monospace;font-size:.9em}
form.inl{display:inline}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:.3rem 0;padding:.4rem .6rem;border:1px solid var(--line);border-radius:.4rem;background:var(--bg);font:.85rem ui-monospace,monospace}.da{background:rgba(22,163,74,.18)}.dr{background:rgba(220,38,38,.18)}.dl{white-space:pre-wrap;font:.85rem ui-monospace,monospace}details summary{cursor:pointer}@media (max-width:600px){main{padding:.6rem}}
`;

export interface Ctx { csrf: string; userId: string }

const NAV: [string, string][] = [['/', 'Status สถานะ'], ['/config', 'Config'], ['/cards', 'Cards'], ['/propose', 'Change เปลี่ยน'], ['/knowledge', 'Knowledge ความรู้'], ['/devjobs', 'Dev jobs'], ['/audit', 'Audit'], ['/spend', 'Spend'], ['/members', 'Members'], ['/channels', 'Channels'], ['/secrets', 'Secrets ค่า env']];

const csrfField = (c: Ctx) => html`<input type="hidden" name="_csrf" value="${c.csrf}">`;

export function layout(title: string, body: SafeHtml, c: Ctx | null): string {
  const nav = c ? html`<nav>${NAV.map(([h, l]) => html`<a href="${h}">${l}</a>`)}</nav>
    <form method="post" action="/logout">${csrfField(c)}<button class="sec" type="submit">Logout</button></form>
    <form method="post" action="/revoke-all">${csrfField(c)}<button class="sec" type="submit">Revoke all sessions</button></form>` : html`<nav><strong>Labworkspace dashboard</strong></nav>`;
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - dashboard</title><link rel="stylesheet" href="/app.css"></head>
<body><header>${nav}</header><main><h1>${title}</h1>${body}</main></body></html>`.value;
}

export function messagePage(title: string, text: string, c: Ctx | null): string {
  return layout(title, html`<div class="card">${text}</div>`, c);
}

export function loginPage(token: string): string {
  return layout('Sign in', html`<div class="card"><p>One-time sign-in for the Labworkspace dashboard (local). This link works once and expires 5 minutes after /dashboard.</p>
<form method="post" action="/login"><input type="hidden" name="t" value="${token}"><button type="submit">Continue</button></form></div>`, null);
}

export interface StatusView { db: string; clients: string[]; halted: boolean; provider?: string | undefined; offDay?: boolean | undefined; offDayReason?: string | undefined }

export function statusPage(s: StatusView, c: Ctx): string {
  return layout('Status', html`<div class="card"><table>
<tr><th>Database</th><td>${s.db}</td></tr>
<tr><th>Bots online</th><td>${s.clients.length ? s.clients.join(', ') : 'none'}</td></tr>
<tr><th>Halt</th><td>${s.halted ? 'HALTED (use /resume in Discord)' : 'running'} <span class="muted">(read only)</span></td></tr>
<tr><th>Provider</th><td>${s.provider ?? 'unknown'}</td></tr>
<tr><th>Off day</th><td>${s.offDay === undefined ? 'unknown' : s.offDay ? `yes (${s.offDayReason ?? 'off day'})` : 'no'}</td></tr></table></div>`, c);
}

const MAX_VALUE = 600;
/** S37e/S48: a value the masker would change is never shown. */
export function shownValue(v: unknown): string {
  const s = JSON.stringify(v) ?? 'undefined';
  if (redactText(s) !== s) return '(hidden)';
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}...` : s;
}

export function configPage(rows: { key: string; value: unknown }[], halted: boolean, c: Ctx): string {
  return layout('Config', html`<p class="muted">Read only. Changes go through "Change" and need Apply. Halt state: <strong>${halted ? 'halted' : 'running'}</strong>. Secrets and provider keys are never shown.</p>
<div class="card"><table><tr><th>Key</th><th>Value</th></tr>${rows.map((r) => html`<tr><td><code>${r.key}</code></td><td><code>${shownValue(r.value)}</code></td></tr>`)}</table></div>`, c);
}

interface DisplayItem { label: string; old: string; neu: string; risk?: boolean; refs?: { kind: string; id: string }[]; detail?: string }

function diff(card: AdminCard, names: (id: string) => string | null): SafeHtml {
  const items = ((card.snapshot as { display?: DisplayItem[] } | null)?.display ?? []);
  if (!items.length) return html`<p class="muted">No preview stored for this card.</p>`;
  return html`<table><tr><th>Item</th><th>Old</th><th>New</th></tr>${items.map((i) => html`<tr><td>${i.risk ? raw('<span class="warn">&#9888;</span> ') : ''}${i.label}${(i.refs ?? []).map((r) => html`<br><code>${r.kind} ${r.id}</code>${names(r.id) ? html` ${names(r.id)}` : ''}`)}</td><td>${i.old}</td><td>${i.neu}${i.detail ? html`<br><span class="muted">${i.detail}</span>` : ''}</td></tr>`)}</table>`;
}

export function cardsPage(cards: AdminCard[], c: Ctx, names: (id: string) => string | null): string {
  const mine = (x: AdminCard) => x.origin === 'dashboard' && x.proposerId === c.userId;
  const body = cards.length ? cards.map((x) => html`<div class="card"><strong>${x.kind}</strong> <code>#${x.id.slice(0, 8)}</code> ${x.tainted ? raw('<span class="warn">(tainted run)</span>') : ''}
<div class="muted">proposed by <code>${x.proposerId}</code> via ${x.origin}, expires ${x.expiresAt.toISOString()}</div>
${x.origin === 'dashboard' ? diff(x, names) : html`<p class="muted">Created in Discord: confirm it there. Read only here.</p>`}
${mine(x) ? html`<form class="inl" method="post" action="/cards/apply">${csrfField(c)}<input type="hidden" name="card" value="${x.id}"><button type="submit">Apply</button></form>
<form class="inl" method="post" action="/cards/cancel">${csrfField(c)}<input type="hidden" name="card" value="${x.id}"><button class="sec" type="submit">Cancel</button></form>` : ''}</div>`) : html`<p>No pending cards.</p>`;
  return layout('Pending cards', html`${body}`, c);
}

export function proposePage(reg: SettingsRegistry, caps: Record<string, string | null>, c: Ctx): string {
  const forms = (a: SettingsAction) => html`<details class="card"><summary>${a.label}</summary>${a.fields.length === 0 || caps[a.family]
    ? html`<p class="muted">${caps[a.family] ?? 'Not available.'}</p>`
    : html`<form method="post" action="/propose"><input type="hidden" name="action" value="${a.id}">${csrfField(c)}
${a.fields.map((f) => html`<label for="${a.id}-${f.id}">${f.label}${f.hint ? html` <span class="muted">(${f.hint})</span>` : ''}</label>${f.style === 'paragraph' ? html`<textarea id="${a.id}-${f.id}" name="f_${f.id}" maxlength="${f.maxLength}" ${f.required ? 'required' : ''}></textarea>` : html`<input id="${a.id}-${f.id}" name="f_${f.id}" maxlength="${f.maxLength}" ${f.required ? 'required' : ''}>`}`)}
<button type="submit">Show diff</button></form>`}</details>`;
  return layout('Change', html`<p class="muted">Each form creates a card. You review the diff on "Cards" and press Apply. Same checks as in Discord.</p>
${SECTIONS.map((s) => html`<h2>${s.label} <span class="muted">${s.th}</span></h2>${caps[s.family] && s.family === 'server' ? html`<p class="muted">${caps[s.family]}</p>` : ''}${reg.list().filter((a) => a.section === s.id && !(a.family === 'server' && caps['server'])).map(forms)}`)}`, c);
}

/** SPEND-1: read-only spend page (no form, no script, no POST route). Every value goes through `html`, which escapes it (Gate 1 S17). */
export function spendPage(v: SpendView | null, c: Ctx): string {
  if (!v) return layout('Spend', html`<div class="card muted">Spend tracking is not available in this process.</div>`, c);
  const usd = (n: number) => `$${n.toFixed(n < 1 && n !== 0 ? 4 : 2)}`;
  const depts = [...new Set(v.days.map((d) => d.deptId))].sort();
  const days = [...new Set(v.days.map((d) => d.day))];
  const cell = (day: string, dept: string) => v.days.find((d) => d.day === day && d.deptId === dept)?.usd ?? 0;
  return layout('Spend', html`<p class="muted">Local days of the schedule time zone; today is ${v.today}. Read only: budgets are set with /budget dept in Discord.</p>
<h2>Last 30 days by department</h2><div class="card"><table><tr><th>Day</th>${depts.map((d) => html`<th>${d}</th>`)}</tr>
${days.map((day) => html`<tr><td>${day}</td>${depts.map((d) => html`<td>${usd(cell(day, d))}</td>`)}</tr>`)}</table></div>
<h2>By provider</h2><div class="card"><table><tr><th>Provider</th><th>30 days</th></tr>${v.providers.map((p) => html`<tr><td>${p.provider}</td><td>${usd(p.usd)}</td></tr>`)}</table></div>
<h2>By tool</h2><div class="card"><table><tr><th>Tool</th><th>30 days</th></tr>${v.tools.map((t) => html`<tr><td>${t.tool}</td><td>${usd(t.usd)}</td></tr>`)}</table></div>
<h2>Budgets this month</h2><div class="card"><table><tr><th>Department</th><th>Month to date</th><th>Cap</th></tr>${v.budgets.map((b) => html`<tr><td>${b.dept}</td><td>${usd(b.mtd)}</td><td>${usd(b.cap)}${b.raisedFrom !== undefined ? ` (raised from ${usd(b.raisedFrom)})` : ''}</td></tr>`)}</table></div>
<h2>Raise overrides</h2><div class="card"><table><tr><th>Department</th><th>Month</th><th>Cap</th><th>Status</th><th>Expires</th></tr>${v.overrides.map((o) => html`<tr><td>${o.dept}</td><td>${o.month}</td><td>${usd(o.oldCap)} to ${usd(o.newCap)}</td><td>${o.status}</td><td>${o.expiresAt}</td></tr>`)}</table></div>
<h2>Last alerts</h2><div class="card"><table><tr><th>Period</th><th>Kind</th><th>Scope</th><th>Posted</th><th>Detail</th></tr>${v.alerts.map((a) => html`<tr><td>${a.period}</td><td>${a.kind}</td><td>${a.scope}</td><td>${a.posted ? 'yes' : `no (${a.attempts})`}</td><td>${a.summary}</td></tr>`)}</table></div>`, c);
}

export interface AuditQuery { actor: string; action: string; sort: 'ts' | 'actor' | 'action'; dir: 'asc' | 'desc'; page: number }

export function auditPage(rows: AuditRow[], q: AuditQuery, c: Ctx): string {
  const qs = (page: number) => `/audit?actor=${encodeURIComponent(q.actor)}&action=${encodeURIComponent(q.action)}&sort=${q.sort}&dir=${q.dir}&page=${page}`;
  return layout('Audit log', html`<form method="get" action="/audit" class="card"><label for="actor">Actor</label><input id="actor" name="actor" value="${q.actor}" maxlength="80">
<label for="action">Action starts with</label><input id="action" name="action" value="${q.action}" maxlength="80">
<label for="sort">Sort</label><select id="sort" name="sort">${(['ts', 'actor', 'action'] as const).map((s) => html`<option value="${s}" ${s === q.sort ? 'selected' : ''}>${s}</option>`)}</select>
<select name="dir" aria-label="direction"><option value="desc" ${q.dir === 'desc' ? 'selected' : ''}>newest first</option><option value="asc" ${q.dir === 'asc' ? 'selected' : ''}>oldest first</option></select>
<button type="submit">Filter</button></form>
<div class="card"><table><tr><th>Time</th><th>Actor</th><th>Action</th><th>Tool</th><th>Outcome</th></tr>
${rows.map((r) => html`<tr><td>${r.ts.toISOString()}</td><td>${r.actor}</td><td>${r.action}</td><td>${r.tool ?? ''}</td><td>${r.outcome ?? ''}</td></tr>`)}</table></div>
<p>${q.page > 0 ? html`<a href="${qs(q.page - 1)}">Newer page</a> ` : ''}${rows.length === 50 ? html`<a href="${qs(q.page + 1)}">Next page</a>` : ''}</p>`, c);
}

export function membersPage(rows: { id: string; name: string; roles: string[] }[] | string, c: Ctx): string {
  if (typeof rows === 'string') return layout('Members', html`<div class="card muted">${rows}</div>`, c);
  return layout('Members', html`<div class="card"><table><tr><th>Name</th><th>Id</th><th>Roles</th></tr>${rows.map((r) => html`<tr><td>${r.name}</td><td><code>${r.id}</code></td><td>${r.roles.join(', ')}</td></tr>`)}</table></div>`, c);
}

export function channelsPage(rows: { id: string; name: string; parentId: string | null; type: number }[] | string, lockedCount: number, c: Ctx): string {
  if (typeof rows === 'string') return layout('Channels', html`<div class="card muted">${rows}</div>`, c);
  return layout('Channels', html`<p class="muted">${lockedCount} protected channel${lockedCount === 1 ? '' : 's'}: locked (name, topic and overwrites are never shown).</p>
<div class="card"><table><tr><th>Name</th><th>Id</th><th>Category</th><th>Type</th></tr>${rows.map((r) => html`<tr><td>${r.name}</td><td><code>${r.id}</code></td><td>${r.parentId ?? ''}</td><td>${r.type}</td></tr>`)}</table></div>`, c);
}

/** E14: fixed text, no key status. */
export const stepUpPage = (c: Ctx): string => messagePage('Log in again', 'Changing secrets needs a fresh sign-in (less than 10 minutes old). Run /dashboard in Discord, open the new link, then come back to Secrets.', c);

/** Status is presence only (E16): never a length, prefix, time or hash. Inputs never carry a value. */
export function envPage(rows: { key: string; group: EnvGroup; set: boolean }[] | null, c: Ctx, flash?: { ok: boolean; text: string }): string {
  const banner = flash ? html`<div class="card ${flash.ok ? '' : 'warn'}">${flash.text}</div>` : '';
  if (!rows) return layout('Secrets ค่า env', html`${banner}<div class="card">The env file is not available or does not pass the safety checks (a 0600 file in a 0700 directory, owned by you). Nothing was changed.</div>`, c);
  return layout('Secrets ค่า env', html`${banner}<p class="muted">Write only. Values are never shown, here or anywhere else. A restart is needed after a change (the owner restarts with dev.sh). Replacing a provider key changes which provider and account the app uses.</p>
${GROUPS.map((g) => html`<h2>${g}</h2><div class="card"><table><tr><th>Key</th><th>Status</th><th>Set or replace</th></tr>
${rows.filter((r) => r.group === g).map((r) => html`<tr><td><code>${r.key}</code>${keyNote(r.key) ? html`<br><span class="muted">${keyNote(r.key)}</span>` : ''}</td><td>${r.set ? 'set' : 'unset'}</td>
<td><form method="post" action="/secrets/set" autocomplete="off">${csrfField(c)}<input type="hidden" name="key" value="${r.key}">
<input type="password" name="value" autocomplete="new-password" maxlength="512" required aria-label="New value for ${r.key}"><button type="submit">Save</button></form>
${r.set ? html`<form method="post" action="/secrets/clear" class="inl">${csrfField(c)}<input type="hidden" name="key" value="${r.key}"><button class="sec" type="submit">Clear</button></form>` : ''}</td></tr>`)}</table></div>`)}`, c);
}

/** Escaped text in a <pre>: markdown, HTML and links in knowledge text stay inert (K18). Nothing is rendered, linked or sanitised: it is shown as typed. */
const text = (t: string) => html`<pre>${t}</pre>`;
const diffBlock = (d: string) => html`<pre>${d.split('\n').map((l) => html`<div class="${l.startsWith('+') ? 'da' : l.startsWith('-') ? 'dr' : 'dl'}">${l === '' ? ' ' : l}</div>`)}</pre>`;
const yes = (b: boolean) => (b ? 'yes' : 'no');

/**
 * Gate 1 K18: the self-knowledge page. Read only except through forms that create a proposal step (review, card, reject, rollback, purge);
 * a document, note, lesson or prompt changes only by Apply on a card (the Cards path). Every model-written string goes through `html`
 * escaping inside <pre>; there is no markdown rendering, no raw HTML and no link built from body text.
 */
export function knowledgePage(o: KnowledgeOverview, c: Ctx, flash?: string): string {
  const post = (action: string, fields: Record<string, string | number>, label: string, cls = '') =>
    html`<form class="inl" method="post" action="${action}">${csrfField(c)}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${String(v)}">`)}<button class="${cls}" type="submit">${label}</button></form>`;
  const waiting = o.waiting.length ? o.waiting.map((v) => {
    const p = v.proposal;
    const reviewed = p.reviewedBy === c.userId && p.reviewedAt !== null;
    return html`<div class="card" id="p${p.id}"><strong>${v.title}</strong> <code>#${p.id}</code> <span class="muted">${p.status}</span> ${p.tainted ? raw('<span class="warn">TAINTED</span>') : ''}
${v.warnings.map((w) => html`<p class="warn">&#9888; ${w}</p>`)}
<ul>${v.facts.map((f) => html`<li>${f}</li>`)}</ul>
${v.diff !== null ? html`<h2>Diff</h2>${diffBlock(v.diff)}` : ''}${v.text !== null ? html`<h2>Full text</h2>${text(v.text)}` : ''}
${v.sources.length ? html`<h2>Sources ${p.tainted ? '(read every one)' : ''}</h2>${v.sources.map((s) => html`<div><span class="${s.tainted ? 'warn' : 'muted'}">${s.label}</span>${s.text !== null ? text(s.text) : ''}</div>`)}` : ''}
${p.status === 'open' ? html`${p.tainted && !reviewed ? post('/knowledge/review', { proposal: p.id }, 'I have read the sources and the full text') : ''}
${!p.tainted || reviewed ? post('/knowledge/card', { proposal: p.id }, 'Make card (then Apply)') : ''}
${post('/knowledge/reject', { proposal: p.id }, 'Reject', 'sec')}` : ''}
${p.status === 'card' && p.cardId ? html`<p>Card <code>#${p.cardId.slice(0, 8)}</code> is waiting (15 minutes, once). Only the admin who made it can apply it.</p>
${post('/cards/apply', { card: p.cardId }, 'Apply')} ${post('/cards/cancel', { card: p.cardId }, 'Cancel card', 'sec')}` : ''}</div>`;
  }) : html`<p>Nothing is waiting.</p>`;
  const docs = o.docs.length ? o.docs.map(({ doc, versions }) => html`<details class="card"><summary><code>#${doc.id}</code> ${doc.title} <span class="muted">scope ${doc.scope}, v${doc.version}, ${doc.status}${doc.tainted ? ', tainted' : ''}</span></summary>
${versions.map((v) => html`<h2>Version ${v.version} <span class="muted">${v.createdBy}${v.tainted ? ', tainted' : ''}</span></h2>${text(`${v.title}\n\n${v.body}`)}`)}
${post('/knowledge/purge', { doc: doc.id }, 'Purge (document and all versions)', 'bad')}</details>`) : html`<p>No documents yet.</p>`;
  const notes = o.notes.length ? html`<div class="card"><table><tr><th>Dept</th><th>Note</th><th>State</th></tr>${o.notes.map((n) => html`<tr><td>${n.deptId}</td><td>${n.body}</td><td>${n.pinned ? 'pinned ' : ''}${n.tainted ? 'unverified' : 'verified'} <span class="muted">${n.source}</span></td></tr>`)}</table></div>` : html`<p>No notes yet.</p>`;
  const lessons = o.lessons.length ? html`<div class="card"><table><tr><th>#</th><th>Lesson</th><th>Active</th></tr>${o.lessons.map((l) => html`<tr><td>${l.id}</td><td>${l.text}</td><td>${yes(l.active)}${l.tainted ? ' (tainted)' : ''}</td></tr>`)}</table></div>` : html`<p>No lessons yet.</p>`;
  const prompts = o.prompts.length ? o.prompts.map((p) => html`<details class="card"><summary><code>${p.ref}</code> <span class="muted">newest v${p.versions[0]?.version ?? 0}${p.versions[0]?.tombstone ? ' (file default)' : ''}</span></summary>
${p.versions.map((v) => html`<h2>v${v.version} ${v.tombstone ? '(back to the file default)' : ''} <span class="muted">${v.createdBy ?? 'admin'}${v.restoredFrom ? `, restored from row #${v.restoredFrom}` : ''}</span></h2>${v.tombstone ? '' : html`${text(v.body)}${post('/knowledge/rollback', { ref: p.ref, version: v.id }, `Roll back to v${v.version}`, 'sec')}`}`)}
${p.versions[0] && !p.versions[0].tombstone ? post('/knowledge/rollback', { ref: p.ref, version: 'default' }, 'Roll back to the file default', 'sec') : ''}</details>`) : html`<p>No prompt overrides.</p>`;
  const decided = o.decided.length ? html`<div class="card"><table><tr><th>#</th><th>Kind</th><th>Dept</th><th>Status</th><th>Outcome</th></tr>${o.decided.map((p) => html`<tr><td>${p.id}</td><td>${p.kind}</td><td>${p.deptId}</td><td>${p.status}${p.tainted ? ' (tainted)' : ''}</td><td>${p.outcome ?? ''}</td></tr>`)}</table></div>` : '';
  return layout('Knowledge', html`${flash ? html`<div class="card warn">${flash}</div>` : ''}<p class="muted">Read only. A change is a proposal: review it here, make a card, then Apply. Text from the bots is shown as plain text and is never trusted.</p>
<h2>Waiting for review</h2>${waiting}<h2>Documents</h2>${docs}<h2>Role text versions (prompts)</h2>${prompts}<h2>Lessons</h2>${lessons}<h2>Department notes</h2>${notes}${decided ? html`<h2>Recently decided</h2>${decided}` : ''}`, c);
}

export { esc };

/** Gate 1 self-code X21: read only. Everything is escaped; invisible and bidi characters are written out as <U+XXXX>; long lines wrap and are never cut. */
export function devjobsPage(rows: DevJob[], c: Ctx): string {
  return layout('Dev jobs', html`<p class="muted">Read only. A dev job is a code change the system prepared itself; a card in #setting carries the confirmation.</p>
<div class="card"><table><tr><th>Job</th><th>Status</th><th>Who</th><th>Head</th><th>Spend</th></tr>${rows.map((j) => html`<tr><td><code>${j.id}</code></td><td>${j.status}</td><td><code>${j.requesterId}</code></td><td>${j.headSha ? html`<a href="/devjobs/${j.headSha}"><code>${j.headSha.slice(0, 12)}</code></a>` : '-'}</td><td>$${j.spendUsd.toFixed(2)}</td></tr>`)}</table></div>`, c);
}

interface FactsView { base?: string; head?: string; commits?: number; files?: { path: string; status: string; protected?: boolean; closure?: boolean; test?: boolean; nonSelfModifiable?: boolean }[]; refusals?: string[]; flags?: string[]; deps?: { name: string; version: string; hasInstallScript?: boolean; publishedAt?: string | null }[]; auditNote?: string; lowRiskOnly?: boolean; tests?: { before: number; after: number; typecheck: boolean; build: boolean } }

export function devjobPage(j: DevJob, c: Ctx): string {
  const f = (j.facts ?? {}) as FactsView;
  const v = (j.verdicts ?? {}) as { code?: string; security?: string; findings?: { severity: string; file: string; note: string }[] };
  return layout(`Dev job ${j.id}`, html`
<div class="card"><table>
<tr><th>Status</th><td>${j.status}</td></tr><tr><th>Repository</th><td>${j.repo}</td></tr><tr><th>Requested by</th><td><code>${j.requesterId}</code></td></tr>
<tr><th>Base</th><td><code>${j.baseSha ?? '-'}</code></td></tr><tr><th>Head</th><td><code>${j.headSha ?? '-'}</code></td></tr><tr><th>Bundle sha256</th><td><code>${j.bundleSha256 ?? '-'}</code></td></tr>
<tr><th>Commits</th><td>${f.commits ?? '-'}</td></tr><tr><th>Confirms</th><td>${f.lowRiskOnly === undefined ? '-' : f.lowRiskOnly ? 'a Bot Admin (documentation only)' : 'the owner only (protected paths)'}</td></tr>
<tr><th>Spend</th><td>$${j.spendUsd.toFixed(2)}</td></tr><tr><th>Outcome</th><td>${j.outcome ?? '-'}</td></tr></table></div>
${(f.refusals ?? []).length ? html`<h2 class="bad">Refused</h2><div class="card">${(f.refusals ?? []).map((r) => html`<div class="bad">${r}</div>`)}</div>` : ''}
<h2>Files</h2><div class="card"><table><tr><th>Change</th><th>Path</th><th>Flags</th></tr>${(f.files ?? []).map((x) => html`<tr><td>${x.status}</td><td><code>${x.path}</code></td><td>${[x.protected ? 'protected' : '', x.closure ? 'closure' : '', x.test ? 'test' : '', x.nonSelfModifiable ? 'NON-SELF-MODIFIABLE' : ''].filter(Boolean).join(', ')}</td></tr>`)}</table></div>
${(f.deps ?? []).length ? html`<h2>New dependencies</h2><div class="card">${(f.deps ?? []).map((d) => html`<div><code>${d.name}@${d.version}</code> published ${d.publishedAt ?? 'unknown'}${d.hasInstallScript ? ' - HAS AN INSTALL SCRIPT (never run)' : ''}</div>`)}<p class="muted">${f.auditNote ?? ''}</p></div>` : ''}
<h2>Checks (code-computed)</h2><div class="card">${f.tests ? html`<div>Tests ${f.tests.before} to ${f.tests.after}; type check ${f.tests.typecheck ? 'ok' : 'FAILED'}; build ${f.tests.build ? 'ok' : 'FAILED'} <span class="muted">(from the test container; the executor re-derives everything at apply)</span></div>` : '-'}
${(f.flags ?? []).map((x) => html`<div class="warn">flag: ${x}</div>`)}</div>
<h2>Automated reviews <span class="muted">(model-written, unverified; never sufficient alone)</span></h2><div class="card"><div>Code: ${v.code ?? '-'}; security: ${v.security ?? '-'}</div>${(v.findings ?? []).map((x) => html`<div><span class="muted">${x.severity}</span> <code>${x.file}</code> ${x.note}</div>`)}</div>
<h2>Diff</h2><pre>${j.diff ?? '(no diff stored)'}</pre>
<h2>Log <span class="muted">(redacted)</span></h2><pre>${j.report ?? '-'}</pre>`, c);
}
