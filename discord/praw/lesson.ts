import { describeLesson, planLesson } from '../../tools/plugins/lessons/index.js';
import { ephemeral, type InteractionLike } from '../commands/types.js';
import type { Handler } from './commands.js';
import { prawListReply } from './context.js';

const ADMIN_ONLY = ephemeral('Only a Bot Admin can change lessons.');
const idOf = (i: InteractionLike) => i.options.integer('id') ?? 0;

/**
 * `/lesson add|list|remove|enable|disable` (P13, PF14). list is open to members and shows active lessons only (a Bot Admin also sees
 * inactive ones); every other subcommand is Bot Admin only and audited. add stores source manual with the invoker as author. Imported
 * lessons start inactive and only `enable` switches them on. Replies are ephemeral.
 */
export const lessonCmd: Handler = {
  subs: true,
  ephemeral: true,
  check(i: InteractionLike) {
    if (i.subcommand === 'add' && !(i.options.string('text')?.trim())) return ephemeral('Tell me the lesson.');
    return null;
  },
  async run(i, deps) {
    const repo = deps.lessons;
    if (!repo) return ephemeral('Lessons are not available right now.');
    const admin = deps.isBotAdmin(i);
    if (i.subcommand === 'list') {
      const rows = await repo.list({ includeInactive: admin });
      return prawListReply(rows.length ? rows.slice(0, 25).map((l) => describeLesson(l, 70)).join('\n') : 'No lessons.');
    }
    if (!admin) return ADMIN_ONLY;
    const audit = (action: string, id: string, outcome: string) => deps.audit({ actor: `user:${i.userId}`, action, tool: id, outcome });
    if (i.subcommand === 'add') {
      const plan = planLesson(i.options.string('text') ?? '', deps.cfg.get('lessons.perLessonChars'));
      if ('error' in plan) return ephemeral(`Could not save that lesson: ${plan.error}.`);
      const l = await repo.add({ text: plan.text, source: 'manual', authorId: i.userId, origin: 'slash' });
      await audit('lesson.add', l ? String(l.id) : '-', l ? 'ok' : 'failed');
      return ephemeral(l ? `Lesson #${l.id} saved.` : 'Could not save that lesson.');
    }
    const id = idOf(i);
    if (i.subcommand === 'remove') {
      const ok = await repo.remove(id); // no scope: the admin path
      await audit('lesson.remove', String(id), ok ? 'ok' : 'not_found');
      return ephemeral(ok ? `Lesson #${id} removed.` : `No lesson #${id}.`);
    }
    const on = i.subcommand === 'enable';
    const ok = await repo.setActive(id, on);
    await audit(on ? 'lesson.enable' : 'lesson.disable', String(id), ok ? 'ok' : 'not_found');
    return ephemeral(ok ? `Lesson #${id} ${on ? 'enabled' : 'disabled'}.` : `No lesson #${id}.`);
  },
};
