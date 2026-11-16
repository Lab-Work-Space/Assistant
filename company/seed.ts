import type { DeptId } from '../core/index.js';
import type { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../db/repos/index.js';
import type { PromptDoc } from '../prompts/index.js';
import { NEVER_MAPPED_CHANNEL_IDS } from './channels.js';
import { DENIED_CHANNEL_IDS } from './denylist.js';
import type { DeptSeed, GuildChannelInfo, PersonaSeed } from './types.js';

/** Latest stable Gemini Flash id (https://ai.google.dev/gemini-api/docs/models, checked 2026-10-31). */
export const PRAW_DEFAULT_MODEL = 'gemini-3.8-flash';

export const SEED_DEPARTMENTS: DeptSeed[] = [
  { id: 'hq', name: 'Headquarter', categoryNamePattern: 'Headquarter', workChannelId: '1565652605290414160', color: 0xf1c40f },
  { id: 'rnd', name: 'R&D Innovation', categoryNamePattern: 'R&D', workChannelId: '1565651357845692466', color: 0x9b59b6 },
  { id: 'software', name: 'Software House', categoryNamePattern: 'Software House', workChannelId: '1565682159375749161', color: 0x3498db },
  { id: 'it', name: 'IT General & Infrastructure', categoryNamePattern: 'IT GENERAL', workChannelId: '1565714565520560328', color: 0x1abc9c },
  { id: 'marketing', name: 'Marketing', categoryNamePattern: 'MARKETING', workChannelId: '1565713202405445652', color: 0xe91e63 },
  { id: 'sales', name: 'Sales & Pipeline', categoryNamePattern: 'SALES', workChannelId: '1565713910085058742', color: 0xe67e22 },
  { id: 'hr', name: 'HR Management', categoryNamePattern: 'HR', workChannelId: '1565710126025805955', color: 0x2ecc71 },
  { id: 'finance', name: 'Finance & Accounting', categoryNamePattern: 'FINANCE', workChannelId: '1565712558500093952', color: 0x16a085 },
  { id: 'ops', name: 'Operations Management', categoryNamePattern: 'OPERATIONS', workChannelId: '1565716432124383336', color: 0x95a5a6 },
  { id: 'praw', name: 'พราว', categoryNamePattern: '', workChannelId: null, color: 0xf48fb1, provider: 'gemini', model: PRAW_DEFAULT_MODEL },
];

export const SEED_PERSONAS: Record<string, PersonaSeed> = {
  'system-analyst': { dept: 'software', directChannelId: '1565670817646256178' },
  'ux-ui-consultant': { dept: 'software', directChannelId: '1565670848747143210' },
  'project-manager': { dept: 'software', directChannelId: '1565670958138789960' },
  'project-admin': { dept: 'software', directChannelId: '1565670999418998824' },
  'pair-programmer': { dept: 'software', directChannelId: '1565671027894255696' },
  'code-reviewer-qa': { dept: 'software', directChannelId: '1565671058919399544' },
  'research-scientist': { dept: 'rnd', directChannelId: '1565671091836293141' },
  'innovation-brainstorm': { dept: 'rnd', directChannelId: '1565671116364587068' },
  'ceo-business-advisor': { dept: 'hq', directChannelId: '1565671151903178772' },
  'legal-and-contracts': { dept: 'hq', directChannelId: '1565671177060487229' },
};

export interface OrgRepos {
  departments: DepartmentRepo;
  personas: PersonaRepo;
  channelMap: ChannelMapRepo;
  /** SKILLS-1: the skill cache source. Absent (tests that predate it) = no skills, fail closed. */
  skills?: { loadAll(): Promise<import('../skills/types.js').SkillSnapshot> };
}

/** Insert-if-missing: rows the owner has edited are never overwritten. */
export async function seed(repos: OrgRepos, prompts: Map<string, PromptDoc>): Promise<void> {
  for (const d of SEED_DEPARTMENTS) {
    if (await repos.departments.get(d.id)) continue;
    await repos.departments.upsert({
      id: d.id,
      name: d.name,
      categoryNamePattern: d.categoryNamePattern,
      workChannelId: d.workChannelId,
      color: d.color,
      model: d.model ?? null,
      provider: d.provider ?? null,
      enabled: true,
    });
  }
  for (const [id, p] of Object.entries(SEED_PERSONAS)) {
    if (await repos.personas.get(id)) continue;
    const ref = `members/${id}`;
    const doc = prompts.get(ref);
    if (!doc) throw new Error(`seed: missing prompt ${ref}`);
    await repos.personas.upsert({
      id,
      deptId: p.dept,
      name: doc.meta.name,
      avatarUrl: null,
      promptRef: ref,
      model: null,
      provider: null,
      tools: doc.meta.tools,
      directChannelId: p.directChannelId,
      enabled: true,
    });
  }
}

function compile(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/** Maps channels directly under a department's category; inserts missing rows only. Returns rows inserted. */
export async function syncChannelMap(guildChannels: GuildChannelInfo[], repos: OrgRepos): Promise<number> {
  const depts = (await repos.departments.list())
    .map((d) => ({ d, re: compile(d.categoryNamePattern) }))
    .filter((x): x is { d: (typeof x)['d']; re: RegExp } => x.re !== null && x.d.categoryNamePattern !== '');
  const categories = new Map(guildChannels.filter((c) => c.type === 4).map((c) => [c.id, c]));
  const deptOfCategory = new Map<string, DeptId>();
  for (const cat of categories.values()) {
    const hit = depts.find((x) => x.re.test(cat.name));
    if (hit) deptOfCategory.set(cat.id, hit.d.id as DeptId);
  }
  let inserted = 0;
  for (const c of guildChannels) {
    if (c.type === 4 || !c.parentId) continue;
    if (DENIED_CHANNEL_IDS.includes(c.id) || DENIED_CHANNEL_IDS.includes(c.parentId)) continue;
    if (NEVER_MAPPED_CHANNEL_IDS.includes(c.id)) continue; // the goals forum under Headquarter would otherwise route to hq twice
    const deptId = deptOfCategory.get(c.parentId);
    if (!deptId) continue;
    if (await repos.channelMap.get(c.id)) continue;
    const dept = depts.find((x) => x.d.id === deptId)!.d;
    await repos.channelMap.upsert({ channelId: c.id, deptId, isWork: dept.workChannelId === c.id });
    inserted++;
  }
  return inserted;
}
