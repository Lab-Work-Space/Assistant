import type { TaskStatus } from '../../db/repos/tasks.js';
import type { EmbedStyle } from './style.js';

export const STATUS_COLORS: Record<TaskStatus, number> = {
  todo: 0x95a5a6,
  doing: 0x3498db,
  review: 0x9b59b6,
  done: 0x2ecc71,
  blocked: 0xe74c3c,
  awaiting_approval: 0xf1c40f,
  cancelled: 0x7f8c8d,
};

export const taskStyle: EmbedStyle = (_p, ctx) => ({
  color: ctx.status ? STATUS_COLORS[ctx.status] : ctx.deptColor,
});
