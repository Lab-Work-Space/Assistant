import { AdminOp } from './ops.js';
import { ServerOp } from '../discord/server/server-ops.js';
import type { ActionField, BuildResult, SettingsAction } from './settings.js';

/**
 * The server-management actions of the settings panel and the dashboard (Gate 1 S37c, S37d): they replace the stubs in admin/settings.ts.
 * Each one turns typed fields into the SAME structured op the model path uses (`ServerOp`, or `AdminOp` `welcome_set`), validated by the real
 * schemas; free text is length-capped and goes nowhere near a model. A typed user id counts as a member the admin NAMED (S18, S37d): it is
 * returned in `named`, which the registry hands to the console as `Proposer.namedIds`.
 */
const ID = /^\d{17,20}$/;
const f = (id: string, label: string, maxLength: number, o: Partial<ActionField> = {}): ActionField => ({ id, label, style: 'short', required: true, maxLength, ...o });
const bad = (error: string): BuildResult => ({ ok: false, error });
const t = (v: Record<string, string>, k: string): string => (v[k] ?? '').trim();
const BAD = 'Some value is not valid. Check the fields and try again.';
const YES = new Set(['yes', 'y', 'true', 'on', '1']);
const NO = new Set(['no', 'n', 'false', 'off', '0']);
const bool = (s: string): boolean | null => (YES.has(s.toLowerCase()) ? true : NO.has(s.toLowerCase()) ? false : null);
const ids = (s: string): string[] | null => {
  const parts = s.split(/[\s,]+/).filter(Boolean);
  return parts.every((p) => ID.test(p)) ? parts : null;
};
const int = (s: string): number | null => (/^\d{1,9}$/.test(s) ? Number(s) : null);

function server(raw: unknown, named: string[] = []): BuildResult {
  const r = ServerOp.safeParse(raw);
  return r.success ? { ok: true, kind: 'server', raw: [r.data], ...(named.length ? { named } : {}) } : bad(BAD);
}
const idField = (id: string, label: string, o: Partial<ActionField> = {}) => f(id, label, 20, { hint: 'Discord id (digits)', ...o });
const reasonField = f('reason', 'Reason (shown in the audit log, 200 max)', 200, { required: false });

export function serverActions(): SettingsAction[] {
  return [
    {
      id: 'welcome_set', section: 'welcome', family: 'server', label: 'Welcome message and default roles',
      fields: [f('enabled', 'Enabled? yes or no (empty = unchanged)', 4, { required: false }), idField('roleIds', 'Default role ids, comma separated (empty = unchanged)', { required: false, hint: '17-20 digit ids' }),
        { ...f('message', 'Message, {user} only, 500 max (empty = unchanged)', 500, { required: false }), style: 'paragraph' }, idField('channelId', 'Channel id (empty = unchanged)', { required: false }), f('raid', 'Raid limit per minute 3-30 (empty = unchanged)', 2, { required: false })],
      build: (v) => {
        const o: Record<string, unknown> = { op: 'welcome_set' };
        if (t(v, 'enabled')) { const b = bool(t(v, 'enabled')); if (b === null) return bad('Enabled must be yes or no.'); o.enabled = b; }
        if (t(v, 'roleIds')) { const l = ids(t(v, 'roleIds')); if (!l) return bad('Role ids must be Discord ids (digits).'); o.roleIds = l; }
        if (v.message !== undefined && v.message.trim() !== '') o.message = v.message.trim();
        if (t(v, 'channelId')) { if (!ID.test(t(v, 'channelId'))) return bad('Channel id must be digits.'); o.channelId = t(v, 'channelId'); }
        if (t(v, 'raid')) { const n = int(t(v, 'raid')); if (n === null) return bad('The raid limit is a whole number.'); o.raidPerMinute = n; }
        const r = AdminOp.safeParse(o);
        return r.success ? { ok: true, kind: 'admin_op', raw: r.data } : bad(BAD);
      },
    },
    {
      id: 'automod_rule', section: 'automod', family: 'server', label: 'New AutoMod keyword rule',
      fields: [f('name', 'Rule name', 100), { ...f('keywords', 'Keywords, comma separated', 600), style: 'paragraph' }, f('actions', 'Actions: block, alert, timeout=<seconds, max 86400>', 60), f('enabled', 'Enabled? yes or no', 4, { required: false })],
      build: (v) => {
        const keywords = t(v, 'keywords').split(',').map((k) => k.trim()).filter(Boolean);
        const parts = t(v, 'actions').split(/[\s,]+/).filter(Boolean);
        const actions: Record<string, unknown> = {};
        for (const p of parts) {
          if (p === 'block') actions.block = {};
          else if (p === 'alert') actions.alert = true;
          else if (/^timeout=\d{1,6}$/.test(p)) actions.timeoutSeconds = Number(p.slice(8));
          else return bad('Actions are block, alert and timeout=<seconds>.');
        }
        const enabled = t(v, 'enabled') ? bool(t(v, 'enabled')) : true;
        return enabled === null ? bad('Enabled must be yes or no.') : server({ kind: 'automod.create', name: t(v, 'name'), trigger: { type: 'keyword', keywords }, actions, enabled });
      },
    },
    {
      id: 'server_settings', section: 'server', family: 'server', label: 'Server settings',
      fields: [f('name', 'Server name (empty = unchanged)', 100, { required: false }), f('description', 'Description, 120 max (empty = unchanged, - clears)', 120, { required: false }),
        idField('systemChannel', 'System channel id (empty = unchanged, - clears)', { required: false }), idField('rulesChannel', 'Rules channel id (empty = unchanged, - clears)', { required: false })],
      build: (v) => {
        const o: Record<string, unknown> = { kind: 'guild.edit' };
        if (t(v, 'name')) o.name = t(v, 'name');
        if (t(v, 'description')) o.description = t(v, 'description') === '-' ? null : t(v, 'description');
        for (const k of ['systemChannel', 'rulesChannel']) {
          const x = t(v, k);
          if (x) { if (x !== '-' && !ID.test(x)) return bad('Channel ids are digits.'); o[k] = x === '-' ? null : x; }
        }
        return server(o);
      },
    },
    {
      id: 'server_event', section: 'server', family: 'server', label: 'Scheduled event',
      fields: [f('name', 'Event name', 100), f('type', 'voice, stage or external', 8), f('where', 'Channel id (voice, stage) or https URL (external)', 100), f('start', 'Start, ISO e.g. 2026-12-01T18:00:00Z', 25), f('end', 'End, ISO (needed for external)', 25, { required: false })],
      build: (v) => {
        const type = t(v, 'type');
        if (type !== 'voice' && type !== 'stage' && type !== 'external') return bad('Type must be voice, stage or external.');
        const place = type === 'external' ? { location: t(v, 'where') } : { channel: t(v, 'where') };
        return server({ kind: 'event.create', name: t(v, 'name'), type, ...place, start: t(v, 'start'), ...(t(v, 'end') ? { end: t(v, 'end') } : {}) });
      },
    },
    {
      id: 'mod_timeout', section: 'moderation', family: 'server', label: 'Timeout a member', fields: [idField('member', 'Member id'), f('minutes', 'Minutes (1-40320)', 6), reasonField],
      build: (v) => { const m = int(t(v, 'minutes')); return ID.test(t(v, 'member')) && m !== null ? server({ kind: 'member.timeout', member: t(v, 'member'), minutes: m, ...(t(v, 'reason') ? { reason: t(v, 'reason') } : {}) }, [t(v, 'member')]) : bad('Give a member id and whole minutes.'); },
    },
    {
      id: 'mod_kick', section: 'moderation', family: 'server', label: 'Kick a member', fields: [idField('member', 'Member id'), reasonField],
      build: (v) => (ID.test(t(v, 'member')) ? server({ kind: 'member.kick', member: t(v, 'member'), ...(t(v, 'reason') ? { reason: t(v, 'reason') } : {}) }, [t(v, 'member')]) : bad('Give a member id (digits).')),
    },
    {
      id: 'mod_ban', section: 'moderation', family: 'server', label: 'Ban a member', fields: [idField('member', 'Member id'), f('days', 'Delete messages of the last N days (0-1, default 0)', 1, { required: false }), reasonField],
      build: (v) => {
        const d = t(v, 'days') ? int(t(v, 'days')) : 0;
        return ID.test(t(v, 'member')) && d !== null ? server({ kind: 'member.ban', member: t(v, 'member'), deleteDays: d, ...(t(v, 'reason') ? { reason: t(v, 'reason') } : {}) }, [t(v, 'member')]) : bad('Give a member id and 0 or 1 days.');
      },
    },
  ];
}
