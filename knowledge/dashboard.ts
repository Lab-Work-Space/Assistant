import { redactText } from '../core/logger.js';
import type { DeptNote, DeptNoteRepo, PromptOverride, PromptOverrideRepo } from '../db/repos/ledger.js';
import type { KbDoc, KbRepo, KbVersion, ProposalRepo, Proposal } from '../db/repos/knowledge.js';
import type { Lesson, LessonRepo } from '../db/repos/lessons.js';
import type { AuditFn } from '../governance/audit.js';
import type { KnowledgeService, ProposalView, Proposed } from './service.js';

export interface KnowledgeOverview {
  waiting: ProposalView[];
  decided: Pick<Proposal, 'id' | 'kind' | 'deptId' | 'status' | 'outcome' | 'tainted'>[];
  docs: { doc: KbDoc; versions: KbVersion[] }[];
  notes: DeptNote[];
  lessons: Lesson[];
  prompts: { ref: string; versions: PromptOverride[] }[];
}

/** What the Knowledge page reads and the few writes it makes. Every write is a proposal step; nothing here changes a document, note, lesson or prompt. */
export interface DashboardKnowledge {
  overview(): Promise<KnowledgeOverview>;
  /** K3: the Bot Admin read a tainted proposal's sources (the explicit second step before a card can be made). */
  review(userId: string, proposalId: number): Promise<boolean>;
  reject(userId: string, proposalId: number): Promise<boolean>;
  rollback(userId: string, ref: string, toVersionId: number | null): Promise<Proposed>;
  purge(userId: string, docId: number): Promise<Proposed>;
}

export function createKnowledgePanel(d: {
  service: KnowledgeService; proposals: ProposalRepo; kb: KbRepo; notes: Pick<DeptNoteRepo, 'listAll'>; lessons: Pick<LessonRepo, 'list'>;
  overrides: Pick<PromptOverrideRepo, 'refs' | 'history'>; audit: AuditFn;
}): DashboardKnowledge {
  const actor = (u: string) => `user:${u} via dashboard`;
  return {
    async overview() {
      // K18: the page lists no secrets. Writes are screened, but rows that predate the screen are masked on the way out too.
      const m = (t: string) => redactText(t);
      const mv = (v: ProposalView): ProposalView => ({ ...v, title: m(v.title), facts: v.facts.map(m), diff: v.diff === null ? null : m(v.diff), text: v.text === null ? null : m(v.text), sources: v.sources.map((s) => ({ ...s, text: s.text === null ? null : m(s.text) })) });
      const waiting = (await Promise.all((await d.proposals.list(['open', 'card'], 50)).map((p) => d.service.view(p)))).map(mv);
      const decided = (await d.proposals.recent(60)).filter((p) => p.status !== 'open' && p.status !== 'card').slice(0, 15)
        .map((p) => ({ id: p.id, kind: p.kind, deptId: p.deptId, status: p.status, outcome: p.outcome, tainted: p.tainted }));
      const docs = await Promise.all((await d.kb.listAll(50)).map(async (doc) => ({ doc: { ...doc, title: m(doc.title), body: m(doc.body) }, versions: (await d.kb.versions(doc.id)).map((v) => ({ ...v, title: m(v.title), body: m(v.body) })) })));
      const prompts = await Promise.all((await d.overrides.refs()).map(async (r) => ({ ref: r.ref, versions: (await d.overrides.history(r.ref)).map((v) => ({ ...v, body: m(v.body) })) })));
      return {
        waiting, decided, docs, prompts,
        notes: (await d.notes.listAll(100)).map((n) => ({ ...n, body: m(n.body) })),
        lessons: (await d.lessons.list({ includeInactive: true })).map((l) => ({ ...l, text: m(l.text) })),
      };
    },
    async review(userId, id) {
      const ok = await d.proposals.markReviewed(id, userId);
      await d.audit({ actor: actor(userId), action: 'knowledge.review', tool: 'dashboard', outcome: `${ok ? 'ok' : 'refused'} proposal:${id}` });
      return ok;
    },
    async reject(userId, id) {
      const ok = await d.proposals.finish(id, 'rejected', `rejected by ${userId}`);
      await d.audit({ actor: actor(userId), action: 'knowledge.reject', tool: 'dashboard', outcome: `${ok ? 'ok' : 'refused'} proposal:${id}` });
      return ok;
    },
    rollback: (userId, ref, to) => d.service.proposeRollback(userId, ref, to),
    purge: (userId, docId) => d.service.proposePurge(userId, docId),
  };
}
