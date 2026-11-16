import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { prompts } from '../agents/test-helpers.js';
import { Org, seed } from '../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { SkillRepo } from '../db/repos/skills.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { FakeConfig } from '../governance/test-helpers.js';
import type { Classifier } from '../knowledge/classifier.js';
import type { GrantEnv } from '../tools/skill-grant.js';
import { SkillService, type SkillDeps } from './service.js';

export const ADMIN = '900000000000000001';
/** Registered plugin tools of the test registry (all with a kind) and one builtin. */
export const KINDS = { clickup_create_task: 'write', web_search: 'read', github_create_branch: 'write', create_task: 'write' } as const;
export const grantEnv: GrantEnv = { registered: () => Object.keys(KINDS), builtins: () => ['create_task'], kindOf: (n) => (KINDS as Record<string, 'read' | 'write' | undefined>)[n] };

export interface Rig {
  db: TestDb; org: Org; repo: SkillRepo; svc: SkillService; cfg: FakeConfig;
  audits: { actor: string; action: string; tool?: string | null; outcome?: string | null }[];
  notices: string[]; classifyCalls: { ref: string; prev: string; next: string }[];
  classify: Classifier; setClassifier(f: Classifier): void;
}

/** A real migrated schema, the seed organisation, a real SkillRepo and Org (skills cache wired), a scripted classifier. */
export async function rig(o: Partial<SkillDeps> = {}): Promise<Rig> {
  const db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  const repo = new SkillRepo(db.pool);
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool), skills: repo };
  await seed(repos, prompts);
  const org = await Org.load(repos, prompts);
  const cfg = new FakeConfig();
  const audits: Rig['audits'] = [];
  const notices: string[] = [];
  const classifyCalls: Rig['classifyCalls'] = [];
  let impl: Classifier = async () => ({ allow: true });
  const classify: Classifier = async (i) => { classifyCalls.push({ ref: i.ref, prev: i.prev, next: i.next }); return impl(i); };
  let clock = 1_000_000;
  const svc = new SkillService({
    repo, org, classify, audit: async (e) => void audits.push(e), secrets: [], grant: grantEnv, cfg: cfg as never,
    notify: async (t) => void notices.push(t), log: { error: vi.fn() },
    now: () => (clock += 3_700_000), // every call is in a new hour: the attempt cap (SK12) has its own test
    ...o,
  });
  return { db, org, repo, svc, cfg, audits, notices, classifyCalls, classify, setClassifier: (f) => { impl = f; } };
}

export const draft = (o: Partial<{ title: string; instructions: string; templates: { name: string; body: string }[]; tools: string[] }> = {}) =>
  ({ title: 'Handover checklist', instructions: 'Write the handover note before you close a task. Keep it short.', templates: [] as { name: string; body: string }[], ...o });

/** Creates a skill the way a department does: propose -> bind a card -> apply. Returns the proposal id. */
export async function createOwned(r: Rig, dept: string, id: string, target: 'dept' | string = 'dept', text = draft()): Promise<number> {
  const out = await r.svc.propose({ kind: 'head', dept: dept as never }, { tainted: false, task: null }, { op: 'create', skill: id, title: text.title, instructions: text.instructions, templates: text.templates, target, reason: 'r' });
  if (!out.ok) throw new Error(`setup propose failed: ${out.code}`);
  const rev = await r.svc.review(out.id);
  if (!rev.ok) throw new Error(`setup review failed: ${rev.code}`);
  await r.repo.attachCard(out.id, `card-${out.id}`, ADMIN);
  const ap = await r.svc.applyProposal(`card-${out.id}`, out.id, ADMIN, rev.sha256);
  if (!ap.ok) throw new Error(`setup apply failed: ${ap.code}`);
  return out.id;
}
