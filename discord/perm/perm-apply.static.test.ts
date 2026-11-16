import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Gate 1 S7: the two executors; only they (inside the separate LW Admin process) call guild write APIs. */
const EXECUTORS = ['discord/perm/perm-apply.ts', 'discord/server/server-apply.ts'];

/** Gate 1 C14. Every way to write roles, members' roles, overwrites or channels through discord.js (and its raw REST client). */
const WRITE_APIS: [string, RegExp][] = [
  ['roles.create/edit/delete/add/remove', /\broles\s*\.\s*(create|edit|delete|add|remove|set)\s*\(/],
  ['setPermissions / setPosition / setPositions', /\.\s*(setPermissions|setPosition|setPositions|setRolePositions|setChannelPositions)\s*\(/],
  ['permissionOverwrites.*', /\bpermissionOverwrites\s*\.\s*(edit|create|set|delete|upsert)\s*\(/],
  ['channels.create/edit/delete', /\bchannels\s*\.\s*(create|edit|delete)\s*\(/],
  ['setParent / lockPermissions', /\.\s*(setParent|lockPermissions)\s*\(/],
  ['raw REST', /\.\s*rest\s*\.\s*(put|patch|post|delete|request)\s*\(|\bRoutes\s*\.\s*(guildRole|guildRoles|channelPermission|guildChannels|guildMemberRole|channel)\b/],
  ['instance edit / setName on role, member or channel', /\b(role|member|channel|ch|r|m|g|guild)\s*\.\s*(edit|setName)\s*\(/],
  ['bracket access to a write namespace', /\[\s*['"`](roles|permissionOverwrites|channels|members)['"`]\s*\]/],
  ['destructured write namespace', /\{[^}]*\b(roles|permissionOverwrites)\b[^}]*\}\s*=\s*[\w.]*(guild|\bg\b|channel|client)/i],
  ['member edit / ban / kick', /\bmembers\s*\.\s*(edit|ban|kick|addRole|removeRole)\s*\(|\.\s*(ban|kick)\s*\(\s*(['"`]|\w+\s*,\s*\{)/],
  // ---- phase 2 (Gate 1 S7)
  ['bans.create/remove, .ban(, .unban(', /\bbans\s*\.\s*(create|remove)\s*\(|\.\s*(ban|unban)\s*\(/],
  ['.kick(', /(?<!this)\.\s*kick\s*\(/],
  ['timeout / disableCommunicationUntil', /(?<!AbortSignal)\.\s*timeout\s*\(|\bdisableCommunicationUntil\b|\bcommunicationDisabledUntil\s*[:(=]/],
  ['bulkDelete', /\bbulkDelete\s*\(/],
  ['messages.delete / message.delete(', /\bmessages\s*\.\s*delete\s*\(|\b(message|msg)\s*\.\s*delete\s*\(/],
  ['pin / unpin', /\.\s*(pin|unpin)\s*\(/],
  ['autoModerationRules.*', /\bautoModerationRules\s*\.\s*(create|edit|delete)\s*\(/],
  ['scheduledEvents.*', /\bscheduledEvents\s*\.\s*(create|edit|delete)\s*\(/],
  ['emojis.* / stickers.*', /\b(emojis|stickers)\s*\.\s*(create|edit|delete)\s*\(/],
  ['guild.edit / setIcon|setBanner|setName|setSystemChannel|setRulesChannel', /\.\s*(setIcon|setBanner|setSystemChannel|setRulesChannel)\s*\(|\b(g|guild)\s*\.\s*setName\s*\(/],
  ['createInvite / invites.*', /\bcreateInvite\s*\(|\binvites\s*\.\s*(create|delete)\s*\(/],
  ['setNickname', /\.\s*setNickname\s*\(/],
  ['threads.* / setArchived|setLocked', /\bthreads\s*\.\s*(create|delete)\s*\(|\.\s*(setArchived|setLocked)\s*\(/],
  // ---- Gate 2 G2SM-10: bypasses of the name patterns
  ['argument-less .delete()', /(?<!\bmap|\bset|\bcache)\.\s*delete\s*\(\s*\)/i],
  ['any access to bans', /\bbans\b/],
  ['raw guild routes', /\bRoutes\s*\.\s*guild(Ban|Bans|Member|AutoModeration|ScheduledEvent|Invite|Prune|Integration)\w*\b/],
  ['.leave(', /\b(g|guild)\s*\.\s*leave\s*\(/],
  ['bracket call of a write verb', /\[\s*['"`](ban|kick|unban|delete|edit|create|timeout|setNickname|bulkDelete)['"`]\s*\]\s*\(/],
  ['Reflect.apply on a member', /Reflect\s*\.\s*apply\s*\(/],
  ['.edit( on any receiver', /\.\s*edit\s*\(/],
  ['channels.delete / setParent / setPosition / lockPermissions', /\bchannels\s*\.\s*(delete|edit|create)\s*\(|\.\s*(setParent|setPosition|lockPermissions)\s*\(/],
];

/**
 * Existing, reviewed call sites outside the executors (Gate 1 S7, global rule 5): exact path, the pattern it uses and why it stays.
 * Anything not listed here fails the scan.
 */
const ALLOWED_ELSEWHERE: Record<string, { what: string[]; why: string }> = {
  'discord/server/server-world.ts': {
    what: ['bulkDelete', 'createInvite / invites.*'],
    why: 'Method declarations of the ServerWriter interface (names only, no discord.js call); the one implementation is discord/server/server-apply.ts.',
  },
  'discord/port.ts': {
    what: ['pin / unpin', 'threads.* / setArchived|setLocked', '.edit( on any receiver'],
    why: 'Praw\'s reviewed phase-1 message features (also editing the bot\'s own posted messages): the pin tool (M2, Pin Messages overwrite on mapped channels only) and one thread per task (opened by the department bot, not an admin op).',
  },
  'discord/panel-port.ts': {
    what: ['pin / unpin', '.edit( on any receiver'],
    why: 'The settings panel pins its own single message in #setting through hq (Pin Messages on that channel only); a reviewed phase-1 settings feature, not an admin op.',
  },
  'admin/panel.ts': {
    what: ['pin / unpin', '.edit( on any receiver'],
    why: 'Calls the panel port\'s pin method for the panel message; a method of our own port, not a guild write API.',
  },
  'executor/world.ts': {
    what: ['any access to bans'],
    why: 'Read-only: g.bans.fetch answers "is this user banned / a member" for the hard limits; no ban is created or removed here.',
  },
  'tools/plugins/pin/index.ts': {
    what: ['pin / unpin'],
    why: 'Calls DiscordPort.pin (discord/port.ts), the only discord.js pin call; it is a method of our own port, not a guild write API.',
  },
};

/** Real source: not tests, fakes, helpers, fixtures, dependencies or build output. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '.claude'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (relative(ROOT, p) === 'tests') continue;
      sources(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'test-helpers.ts' && !name.endsWith('-fixture.ts')) out.push(p);
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the two executors are the only writers (Gate 1 C14, S7)', () => {
  const files = sources(ROOT).map((p) => ({ rel: relative(ROOT, p), text: stripComments(readFileSync(p, 'utf8')) }));
  const hitsOf = () => files.flatMap((f) => WRITE_APIS.filter(([, re]) => re.test(f.text)).map(([what]) => ({ rel: f.rel, what })));

  it('scans the whole source tree', () => {
    expect(files.length).toBeGreaterThan(150);
    for (const e of EXECUTORS) expect(files.some((f) => f.rel === e)).toBe(true);
  });

  it('no file other than the two executors calls a guild write API, except the listed and reasoned call sites', () => {
    const stray = hitsOf().filter((h) => !EXECUTORS.includes(h.rel) && !ALLOWED_ELSEWHERE[h.rel]?.what.includes(h.what));
    expect(stray.map((h) => `${h.rel}: ${h.what}`)).toEqual([]);
  });

  it('every listed exception still exists and still needs its entry (no stale allowance)', () => {
    const hits = hitsOf();
    for (const [path, { what, why }] of Object.entries(ALLOWED_ELSEWHERE)) {
      expect(why.length).toBeGreaterThan(10);
      for (const w of what) expect(hits.some((h) => h.rel === path && h.what === w), `${path}: ${w}`).toBe(true);
    }
  });

  it('the executors do use them (the scan can see them)', () => {
    const perm = files.find((x) => x.rel === 'discord/perm/perm-apply.ts')!;
    for (const [what, re] of WRITE_APIS.slice(0, 5)) expect(re.test(perm.text), what).toBe(true);
    const server = files.find((x) => x.rel === 'discord/server/server-apply.ts')!;
    for (const [what, re] of WRITE_APIS.slice(10)) {
      if (what === 'bans.create/remove, .ban(, .unban(' || what === 'createInvite / invites.*') expect(re.test(server.text), what).toBe(true);
    }
  });

  it('the executors are reached only from the executor process and the services that use them', () => {
    const importers = (name: string) => files.filter((f) => new RegExp(`from '(\\.\\.?/)+(discord/)?((perm|server)/)?${name}\\.js'|from '\\./${name}\\.js'`).test(f.text)).map((f) => f.rel).sort();
    expect(importers('perm-apply')).toEqual(['discord/perm/perm-service.ts', 'discord/server/server-apply.ts', 'executor/main.ts']);
    expect(importers('server-apply')).toEqual(['executor/main.ts', 'executor/service.ts']);
  });

  it('the executor client object is reachable only from the executor process (import graph)', () => {
    const importers = (name: string) => files.filter((f) => new RegExp(`from '(\\.\\.?/)+(executor/)?${name}\\.js'|from '\\./${name}\\.js'`).test(f.text)).map((f) => f.rel).sort();
    expect(importers('admin-client')).toEqual(['executor/main.ts']);
    expect(importers('world')).toEqual(['executor/main.ts']);
  });

  it('the main application never imports the executor process modules (only the IPC protocol)', () => {
    const forbidden = /from '(\.\.?\/)+executor\/(main|admin-client|world|service|welcome|handler|rate)\.js'/;
    const main = files.filter((f) => !f.rel.startsWith('executor/') && forbidden.test(f.text)).map((f) => f.rel);
    expect(main).toEqual([]);
  });

  it('the scan catches planted call sites (aliases of the pattern stay visible)', () => {
    const plant = (s: string) => WRITE_APIS.some(([, re]) => re.test(stripComments(s)));
    for (const bad of [
      'await guild.roles.create({})', 'await m.roles.add(id)', 'await ch.permissionOverwrites.edit(a, b)', 'await g.channels.edit(id, {})', 'await c.setParent(x)',
      'await c.lockPermissions()', 'await role.edit({ permissions: 1n })', 'await member.edit({ roles: [] })', "await guild['roles'].create({})", 'const { roles } = guild; ', "await client.rest.put(Routes.channelPermission(a, b), {})", 'await r.setPermissions(1n)', 'await g.members.ban(id)',
      // phase 2 (S7): one planted positive per pattern
      'await g.bans.create(id)', 'await g.bans.remove(id)', 'await m.ban({ reason })', 'await m.kick()', 'await g.members.kick(id)', 'await m.timeout(60000)', 'await m.disableCommunicationUntil(d)', 'x.communicationDisabledUntil = d',
      'await ch.bulkDelete(ids)', 'await ch.messages.delete(id)', 'await message.delete()', 'await msg.delete()', 'await message.pin()', 'await message.unpin()',
      'await g.autoModerationRules.create({})', 'await g.autoModerationRules.edit(id, {})', 'await g.autoModerationRules.delete(id)', 'await g.scheduledEvents.create({})', 'await g.scheduledEvents.edit(id, {})',
      'await g.emojis.create({})', 'await g.stickers.delete(id)', 'await g.setIcon(b)', 'await g.setBanner(b)', 'await g.setSystemChannel(c)', 'await g.setRulesChannel(c)',
      'await ch.createInvite({})', 'await g.invites.create(c, {})', 'await g.invites.delete(code)', 'await m.setNickname("x")', 'await ch.threads.create({})', 'await t.setArchived(true)', 'await t.setLocked(true)',
      'await g.channels.delete(id)', 'await c.setPosition(2)',
      // G2SM-10 planted bypasses
      'await ch.delete()', 'await thread.delete()', 'await rule.delete()', 'await inv.delete()', 'const b = g.bans; b.create(id)', "g.members['ban'](id)", '(g as any)["bans"]', 'const { bans } = g', 'Reflect.apply(g.members.ban, g.members, [id])', 'rest.put(Routes.guildBan(a, b))', 'rest.delete(Routes.guildScheduledEvent(a, b))', 'await g.leave()', 'await t.edit({ archived: true })', 'await w.edit({ SendMessages: null })', 'await x.edit({})',
    ]) expect(plant(bad), bad).toBe(true);
    expect(plant('// guild.roles.create is only in the executor')).toBe(false);
    expect(plant('await guild.channels.fetch(id)')).toBe(false);
    expect(plant('AbortSignal.timeout(5000)')).toBe(false);
  });
});
