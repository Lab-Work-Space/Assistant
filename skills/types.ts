import type { SkillTemplate } from './render.js';

export type SkillStatus = 'active' | 'disabled' | 'archived';
export type TargetKind = 'dept' | 'persona';
export interface SkillTarget { kind: TargetKind; id: string }

/** A skill with its ACTIVE version, as the org cache and the admin views read it. */
export interface SkillRow {
  id: string;
  title: string;
  status: SkillStatus;
  activeVersion: number;
  ownerDept: string | null;
  instructions: string;
  templates: SkillTemplate[];
  tools: string[];
  bodyBytes: number;
  bodySha256: string;
}
export interface AttachmentRow { skillId: string; targetKind: TargetKind; targetId: string; priority: number }
/** Everything the Org caches in one query pair; swapped as a unit (SK11). */
export interface SkillSnapshot { skills: SkillRow[]; attachments: AttachmentRow[] }
