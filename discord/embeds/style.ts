import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { TaskStatus } from '../../db/repos/tasks.js';

export type BuildContext = {
  deptColor: number;
  /** "<Dept> · <Role>" shown in the footer for personas. */
  footerLabel?: string;
  /** Department of the speaking actor; Praw chat replies carry no footer (spec §14.9). */
  dept?: string;
  /** Task status; colours `task` embeds. */
  status?: TaskStatus;
  /** Bot Admin role id; pinged only by governance alerts (Gate 1 D11). */
  adminRoleId?: string;
};

export type EmbedStyle = (p: OutboundPayload, ctx: BuildContext) => { color: number };
