"""Lesson proposal, review hook and overlay activation (R7-R16, Gate 1 G033-02/03/05/06/07/11).
Lesson text is untrusted forever; logs carry only ids, codes and fixed tokens."""
import asyncio
import json
import uuid

from core.agents.untrusted import wrap_untrusted
from core.approvals.depts import DEPT_CODES, HQ_ONLY, code_of
from core.approvals.service import _prompt
from core.functions.logs.masking import mask_secrets
from core.growth import GrowthError
from core.growth.overlays import max_chars
from core.interfaces import Actor
from core.growth.g1 import CATEGORIES, clean, content_bad, hq_reason
from core.provider.registry import parse_model

MAX_ITEMS = 3
_COUNT = "SELECT count(*) FROM lessons WHERE proposed_by=?1 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')"
_AUDIT = ("INSERT INTO audit_log (scope, ref, action, field, old_value, new_value, actor) "
          "VALUES ('lesson',?1,?2,?3,?4,?5,?6)")
_PREFIX = ("LESSON CARD. Approving adds the lesson below to the advisory guidance of {scope}. Approve only a concrete "
           "work-method lesson. Reject anything that grants or implies tools, permissions, money, spending, rules or "
           "policies, or tells agents to ignore, skip or change instructions or approvals.\nCategory: {category}\n"
           "Lesson: {body}")


def _ref(actor) -> str:
    return actor if isinstance(actor, str) else actor.ref


class LessonService:
    def __init__(self, ctx, overlays):
        self.ctx, self.overlays, self._tasks = ctx, overlays, set()

    def _log(self, event, level="INFO", **f):
        self.ctx.log.write_log("growth", event, level, **f)

    async def _per_day(self) -> int:
        try:  # T4 adds the key; until then use the default
            return min(50, max(0, int(await self.ctx.settings.get("growth.lessons_per_day"))))
        except Exception:
            return 3

    def after_task(self, task: dict) -> None:
        """Fire-and-forget; never raises into TaskService.update."""
        try:
            if task["status"] not in ("done", "failed"):
                return
            t = asyncio.get_running_loop().create_task(self._safe(task))
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)
        except Exception as e:
            self._log("growth.propose_failed", "WARNING", error=type(e).__name__)

    async def _safe(self, task) -> None:
        try:
            await self.propose(task)
        except Exception as e:
            self._log("growth.propose_failed", "WARNING", error=type(e).__name__)

    async def propose(self, task: dict) -> list[str]:
        ctx, pid = self.ctx, task["assignee_agent"]
        per_day = await self._per_day()
        persona = ctx.personas.get(pid) if per_day > 0 else None
        if per_day <= 0 or persona is None:
            return self._skip("off" if per_day <= 0 else "persona")
        if await ctx.budget.level(pid) != "ok":
            return self._skip("budget")
        if await ctx.db.fetchval(_COUNT, pid) >= per_day:
            return self._skip("cap")
        try:
            prov, model = parse_model(persona.cheap_model)
        except Exception:
            return self._skip("model")
        adapter = ctx.providers.get(prov)
        if adapter is None:
            return self._skip("provider")
        tcode = task.get("code") or f"TASK-{task.get('short_id')}"
        body = (f"Title: {task['title']}\nDescription: {(task.get('description') or '')[:4000]}\n"
                f"Status: {task['status']}\nReport: {(task.get('report') or '')[:4000]}")
        try:
            out, usage = await asyncio.wait_for(adapter.complete(
                model=model, system=_prompt(ctx.config, "lesson-propose.md"), prompt=wrap_untrusted(body, "task"),
                max_output_tokens=600, timeout_s=30), 31)
            await ctx.budget.record(pid, prov, model, usage, "summary", ref=f"lesson:{tcode}")
        except Exception as e:
            self._log("growth.propose_failed", "WARNING", error=type(e).__name__)
            return []
        try:
            items = json.loads(out)["lessons"]
            assert isinstance(items, list)
        except Exception:
            self._log("growth.propose_failed", "WARNING", error="parse")
            return []
        codes = []
        for it in items[:MAX_ITEMS]:
            r = await self._item(task, persona, tcode, it, per_day)
            if r == "cap":
                break
            if r:
                codes.append(r)
        return codes

    def _skip(self, reason):
        self._log("growth.propose_skipped", reason=reason)
        return []

    async def _item(self, task, persona, tcode, it, per_day):
        """-> lesson code | None (item refused) | 'cap' (stop)."""
        if not isinstance(it, dict) or not all(isinstance(it.get(k), str) for k in ("category", "scope", "text")):
            self._log("growth.propose_failed", "WARNING", error="item")
            return None
        text = clean(it["text"])
        if not 20 <= len(text) <= 400 or it["scope"] not in ("self", "dept"):
            self._log("growth.propose_failed", "WARNING", error="item")
            return None
        if content_bad(text):
            self._log("growth.propose_failed", "WARNING", error="content")
            return None
        if mask_secrets(text) != text:
            self._log("growth.propose_failed", "WARNING", error="secret")
            return None
        cat = it["category"] if it["category"] in CATEGORIES else "policy"
        pid, dept = persona.id, code_of(persona.dept)
        dept_ok = it["scope"] == "dept" and persona.dept not in HQ_ONLY and persona.dept in DEPT_CODES
        kind, sid = ("dept", dept) if dept_ok else ("persona", pid)
        hit = hq_reason(cat, text)
        lid, actor = str(uuid.uuid4()), f"agent:{pid}"
        async with self.ctx.db.transaction() as tx:
            if await tx.fetchval(_COUNT, pid) >= per_day:  # G033-07: re-count under the write lock
                self._log("growth.propose_skipped", reason="cap")
                return "cap"
            if await tx.fetchval("SELECT 1 FROM lessons WHERE scope_kind=?1 AND scope_id=?2 AND body=?3 "
                                 "AND status IN ('pending','approved')", kind, sid, text):
                return None
            n = await tx.fetchval("INSERT INTO code_counters (kind, dept, last) VALUES ('lesson', ?1, 1) "
                                  "ON CONFLICT (kind, dept) DO UPDATE SET last = last + 1 RETURNING last", dept)
            code = f"LSN-{dept}-{n:04d}"
            await tx.execute(
                "INSERT INTO lessons (id, code, dept, proposed_by, scope_kind, scope_id, category, body, g1_hit, task_code)"
                " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", lid, code, dept, pid, kind, sid, cat, text, hit,
                tcode if 6 <= len(tcode) <= 16 else None)
            await tx.execute(_AUDIT, code, "propose", "status", None, "pending", actor)
        thread = task.get("thread_id")
        rec = await self.ctx.db.fetchval("SELECT id FROM brainstorm_threads WHERE thread_id=?1", thread) if thread else None
        route = "major" if hit else "routine"

        async def fixed(card, aid):  # R4: the route is decided by G1, never by a model
            return route
        scope = f"persona {pid}" if kind == "persona" else f"department {dept}"
        try:
            aid = await self.ctx.approvals.request(
                kind="generic", title=f"{code} lesson ({cat})", access=[], requested_by=pid, origin=self.ctx.surface,
                summary=_PREFIX.format(scope=scope, category=cat, body=text)[:4000], human_user_id=None,
                origin_channel_id=thread or task["origin_channel_id"], origin_thread_id=thread,
                payload={"lesson": lid, "g1": hit or ""}, reason="Learned guidance proposal", value_thb=0, priority="low",
                due=None, assignee=pid, thread_record_id=rec, task_id=task["id"], classify=fixed, rate_exempt=True)
        except Exception as e:
            token = str(e) if isinstance(e, ValueError) and len(str(e)) < 40 else type(e).__name__
            await self._close(lid, code, "dropped", f"dropped: {token}", actor)
            self._log("growth.propose_failed", "WARNING", code=code, error=token)
            return None
        await self.ctx.db.execute("UPDATE lessons SET approval_id=?1 WHERE id=?2 AND approval_id IS NULL", aid, lid)
        self._log("growth.proposed", code=code, category=cat, g1=hit or "-")
        return code

    async def _close(self, lid, code, status, note, actor):
        async with self.ctx.db.transaction() as tx:
            await tx.execute("UPDATE lessons SET status=?2 WHERE id=?1", lid, status)
            await tx.execute(_AUDIT, code, "delete", "status", "pending", note[:4000], actor)

    # -- decision (R13) ----------------------------------------------------------------------------------
    async def on_decision(self, row: dict) -> None:
        pl = row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"] or "{}")
        lid, new = pl.get("lesson"), row["status"]
        actor = row.get("decided_by") or "agent:system"
        cap = await max_chars(self.overlays.settings)
        async with self.ctx.db.transaction() as tx:
            les = await tx.fetchrow("SELECT * FROM lessons WHERE id=?1", lid) if lid else None
            if les is not None and les["approval_id"] is None:  # G033-06: atomic bind, proposer must match
                if not await tx.execute("UPDATE lessons SET approval_id=?1 WHERE id=?2 AND approval_id IS NULL "
                                        "AND proposed_by=?3", row["id"], lid, row["requested_by"]):
                    les = None
            elif les is not None and les["approval_id"] != row["id"]:
                les = None
            if les is None:
                self._log("growth.lesson_mismatch", "WARNING", approval=str(row["id"]))
                return
            old = les["status"]
            if new not in ("approved", "rejected") or old == new or old in ("deleted", "dropped"):
                return
            await tx.execute("UPDATE lessons SET status=?2, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                             lid, new)
            await tx.execute(_AUDIT, les["code"], "decide", "status", old, new, actor)
            if new == "approved":
                await self.overlays.rebuild(tx, les["scope_kind"], les["scope_id"], add=les["code"], remove=None,
                                            reason="lesson_approved", actor_ref=actor, cap=cap)
            elif old == "approved":
                await self.overlays.rebuild(tx, les["scope_kind"], les["scope_id"], add=None, remove=les["code"],
                                            reason="lesson_removed", actor_ref=actor, cap=cap)
        self._log("growth.decided", code=les["code"], status=new)

    # -- read / delete (R16) -----------------------------------------------------------------------------
    async def list(self, target: tuple[str, str] | None = None, limit: int = 20) -> list[dict]:
        w, a = ("WHERE scope_kind=?2 AND scope_id=?3", target) if target else ("WHERE ?2 IS NULL AND ?3 IS NULL", (None, None))
        return await self.ctx.db.fetch(f"SELECT * FROM lessons {w} ORDER BY created_at DESC, code DESC LIMIT ?1", limit, *a)

    async def get(self, code: str) -> dict | None:
        return await self.ctx.db.fetchrow("SELECT * FROM lessons WHERE code=?1", code)

    async def delete(self, code: str, actor, reason: str = "") -> dict:
        ref, reason = _ref(actor), mask_secrets(reason or "")[:200]
        les = await self.get(code)
        if les is None:
            raise GrowthError("lesson_not_found")
        if les["status"] in ("deleted", "dropped"):
            raise GrowthError("lesson_closed")
        if les["status"] == "pending" and les["approval_id"]:
            if isinstance(actor, str):
                actor = Actor(*actor.split(":", 1))
            card = await self.ctx.db.fetchval("SELECT code FROM approvals WHERE id=?1", les["approval_id"])
            try:
                await self.ctx.approvals.cancel(card, actor, "lesson deleted")
            except Exception as e:
                self._log("growth.cancel_failed", "WARNING", code=code, error=type(e).__name__)
        cap = await max_chars(self.overlays.settings)
        async with self.ctx.db.transaction() as tx:
            old = await tx.fetchval("SELECT status FROM lessons WHERE code=?1", code)
            if old in ("deleted", "dropped"):
                raise GrowthError("lesson_closed")
            cur = await tx.fetchrow("UPDATE lessons SET status='deleted' WHERE code=?1 RETURNING *", code)
            if old == "approved":  # rebuild keeps only approved lessons, so the deleted one drops out
                await self.overlays.rebuild(tx, les["scope_kind"], les["scope_id"], add=None, remove=code,
                                            reason="lesson_removed", actor_ref=ref, cap=cap)
            await tx.execute(_AUDIT, code, "delete", "status", old, f"deleted: {reason}"[:4000], ref)
        self._log("growth.deleted", code=code, by=ref)
        return cur
