/** SKILLS-1: every limit is a code constant. `config_propose` and `/settings` cannot raise them (Gate 1 S5). */
export const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const TARGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_TITLE_MAX = 100;
export const SKILL_INSTRUCTIONS_MIN = 10;
export const SKILL_INSTRUCTIONS_MAX = 2500;
export const SKILL_TEMPLATES_MAX = 3;
export const SKILL_TEMPLATE_NAME_MAX = 40;
export const SKILL_TEMPLATE_BODY_MAX = 1000;
export const SKILL_TEMPLATES_TOTAL_MAX = 1500;
export const SKILL_TOOLS_MAX = 10;
/** One rendered version block (what is injected, and what the card shows). */
export const SKILL_BLOCK_CHARS_MAX = 4000;
export const SKILL_BLOCK_BYTES_MAX = 6000;
export const SKILLS_PER_DEPT_TARGET = 6;
export const SKILLS_PER_PERSONA_TARGET = 3;
/** Total bytes of the skills section injected into one actor's system text (header included). */
export const SKILL_ACTOR_BUDGET_BYTES = 12_000;
export const OPEN_PROPOSALS_PER_DEPT = 5;
export const SKILLS_IN_LIBRARY_MAX = 200;
/** SK12: `skill_propose` attempts per department per rolling hour (refusals count; in memory, per process). */
export const PROPOSAL_ATTEMPTS_PER_HOUR = 10;
export const PROPOSAL_REASON_MAX = 300;
export const PRIORITY_MAX = 1000;
export const PRIORITY_DEFAULT = 100;
