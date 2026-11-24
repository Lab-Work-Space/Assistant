"""ApprovalService (spec 3.5 as amended by 10.7, TASK-031). Decisions are one conditional UPDATE; expiry is enforced in
SQL. Routing and the classifier run before any transaction; department-level cards are reviewed by the head persona."""
import asyncio
import json
import uuid
from typing import Any, Awaitable, Callable

from core.approvals.depts import HQ_ONLY, code_of
from core.approvals.router import Router
from core.interfaces import Actor, AgentRequest, ApprovalAction, ApproverPolicy, Decision
from core.settings.service import SettingsService

_STATUS = {"approve": "approved", "reject": "rejected"}
NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
_AUDIT = "INSERT INTO audit_log (scope, ref, action, field, old_value, new_value, actor) VALUES ('approval',?1,?2,?3,?4,?5,?6)"
REVIEW_TIMEOUT_S = 240.0
CHAIN_DEPTH = 10  # parent-task hops inspected for head involvement (G2T031-02)


async def _no_classify(card, aid):
    return None  # no classifier wired: fail closed to HQ


class NullPresenter:
    """Used until the Discord (013B) or CLI (025) presenter is set via set_presenter."""

    async def show_request(self, approval):
        return None, None

    async def show_decision(self, approval, actor):
        return None

    async def show_moved(self, old_channel_id, old_message_id, approval):
        return None


class CliDevApproverPolicy:
    """Dev-only CLI policy; usable only when cli_dev_allowed(config). Re-checked per decision (spec 10.7.5)."""
    surface = "cli"
    APPROVERS = frozenset({"admin"})

    def __init__(self, config):
        from core.config import cli_dev_allowed
        if not cli_dev_allowed(config):
            raise RuntimeError("cli_dev_disabled")
        self._config, self._allowed = config, cli_dev_allowed

    async def is_approver(self, actor: Actor) -> bool:
        return actor.kind == "cli" and self._allowed(self._config) and actor.user_id in self.APPROVERS


class PgApprovalService:
    def __init__(self, pool, config, log, policy: ApproverPolicy, presenter=None, *, personas=None, settings=None,
                 classify=None, engine=None):
        self.pool, self.cfg, self.log, self.policy = pool, config, log, policy
        self.presenter = presenter or NullPresenter()
        self.personas, self.engine = personas, engine
        self.settings = settings or SettingsService(pool, config, log, personas)
        self.router = Router(self.settings, personas, classify or _no_classify, log)
        self.sinks_fn = lambda: None  # set by the extension: review runs use the null sink
        self._handlers: dict[str, Callable[[dict[str, Any]], Awaitable[None]]] = {}
        self._tasks: set[asyncio.Task] = set()
        self._sweeper: asyncio.Task | None = None

    def set_presenter(self, presenter) -> None:
        self.presenter = presenter

    def register_handler(self, kind, handler) -> None:
        self._handlers[kind] = handler

    def _log(self, event: str, level: str = "INFO", **f) -> None:
        self.log.write_log("approvals", event, level, **f)

    def _spawn(self, coro) -> None:
        t = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def _present(self, row) -> None:
        try:
            ch, msg = await self.presenter.show_request(row)
            if ch is not None or msg is not None:
                await self.pool.execute("UPDATE approvals SET channel_id=?2, message_id=?3 WHERE id=?1", row["id"], ch, msg)
                row["channel_id"], row["message_id"] = ch, msg
        except Exception as e:
            self._log("approval.present_failed", "ERROR", id=str(row["id"]), error=type(e).__name__)

    async def _show_decision(self, row, actor) -> None:
        try:
            await self.presenter.show_decision(row, actor)
        except Exception as e:
            self._log("approval.present_failed", "ERROR", id=str(row["id"]), error=type(e).__name__)

    async def _linked_task(self, thread_record_id):
        """(task uuid | None, agents involved) for the thread this run lives in. Involved = creators along the parent-task
        chain (depth-bounded, cycle-safe) plus the thread's owner and participants (G2T031-02)."""
        if not thread_record_id:
            return None, frozenset()
        b = await self.pool.fetchrow("SELECT task_id, owner_agent, participants FROM brainstorm_threads WHERE id=?1",
                                     str(thread_record_id))
        if b is None:
            return None, frozenset()
        who = {b["owner_agent"], *(json.loads(x) if isinstance(x := b["participants"], str) else x or [])}
        return b["task_id"], frozenset(who | await self._chain_creators(b["task_id"]))

    async def _chain_creators(self, task_id) -> set:
        who, seen = set(), set()
        while task_id and task_id not in seen and len(seen) < CHAIN_DEPTH:
            seen.add(task_id)
            t = await self.pool.fetchrow("SELECT created_by_kind, created_by_id, parent_task_id FROM tasks WHERE id=?1", task_id)
            if t is None:
                break
            if t["created_by_kind"] == "agent":
                who.add(t["created_by_id"])
            task_id = t["parent_task_id"]
        return who

    async def request(self, *, kind, title, summary, access, requested_by, origin, human_user_id,
                      origin_channel_id, origin_thread_id, payload, reason=None, value_thb=None, priority=None,
                      due=None, assignee=None, other_depts=(), for_dept=None, thread_record_id=None, classify=None, rate_exempt=False,
                      task_id=None) -> str:
        if kind not in self._handlers:
            raise ValueError("unsupported_kind")
        if origin != self.policy.surface:  # G2-07: the request must come from this process's surface
            raise ValueError("origin_mismatch")
        limit, ttl = await self.settings.rate_per_day(), await self.settings.ttl_h()
        count = ("SELECT count(*) FROM approvals WHERE requested_by=?1 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')"
                 " AND json_extract(payload,'$.lesson') IS NULL")  # lesson cards have their own cap (R5)
        if not rate_exempt and await self.pool.fetchval(count, requested_by) >= limit:  # before the classifier: no LLM spend when limited
            raise ValueError("rate_limited")
        persona = self.personas.get(requested_by) if self.personas is not None else None
        dept_slug = for_dept or (persona.dept if persona else "")
        linked, involved = await self._linked_task(thread_record_id)
        if task_id:  # server-only (G033-05): the caller knows the task even when it has no thread row
            involved = involved | await self._chain_creators(task_id)
        task_id = task_id or linked
        if task_id:
            payload = {**payload, "task": task_id}
        if thread_record_id:
            payload = {**payload, "thread": str(thread_record_id)}  # lets _head_checks re-derive involvement
        aid = str(uuid.uuid4())
        card = {"title": title, "summary": summary, "reason": reason, "value_thb": value_thb, "priority": priority}
        level, dept, route_reason = await self.router.route(
            kind=kind, access=list(access), value_thb=value_thb, other_depts=list(other_depts), requested_by=requested_by,
            dept_slug=dept_slug, involved=involved, card=card, aid=aid, classify=classify)
        async with self.pool.transaction() as tx:
            if not rate_exempt and await tx.fetchval(count, requested_by) >= limit:
                raise ValueError("rate_limited")
            prefix = "HQ" if level == "hq" else dept
            n = await tx.fetchval("INSERT INTO code_counters (kind, dept, last) VALUES ('approval', ?1, 1) "
                                  "ON CONFLICT (kind, dept) DO UPDATE SET last = last + 1 RETURNING last", prefix)
            row = await tx.fetchrow(
                "INSERT INTO approvals (id, code, level, dept, kind, title, summary, access, payload, reason, value_thb,"
                " priority, due, assignee, other_depts, route_reason, requested_by, origin, human_user_id,"
                " origin_channel_id, origin_thread_id, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,"
                "?15,?16,?17,?18,?19,?20,?21, strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ?22 || ' hours')) RETURNING *",
                aid, f"APR-{prefix}-{n:04d}", level, dept, kind, title, summary, json.dumps(list(access)),
                json.dumps(payload), reason or None, value_thb, priority, due, assignee or requested_by,
                json.dumps(list(other_depts)), route_reason, requested_by, origin, human_user_id, origin_channel_id,
                origin_thread_id, ttl)
        await self._present(row)
        self._log("approval.requested", id=aid, code=row["code"], kind=kind, status=level, reason=route_reason, by=requested_by)
        if level == "dept":
            self._spawn(self._review(row))
        return aid

    # -- AI head review (R5) -----------------------------------------------------------------------------
    async def _review(self, row) -> None:
        try:
            head = await self.settings.head(row["dept"])
            if head is not None and self.engine is not None:
                self._log("approval.review_started", code=row["code"], agent=head)
                card = (f"Code: {row['code']}\nTitle: {row['title']}\nDepartment: {row['dept']}\nRequested by: "
                        f"{row['requested_by']}\nValue (THB): {row['value_thb']}\nPriority: {row['priority']}\n"
                        f"Due: {row['due']}\nReason: {row['reason']}\nSummary: {row['summary']}")
                sinks = self.sinks_fn()
                sink = sinks.null() if sinks is not None else None
                extra = _prompt(self.cfg, "approval-review.md")
                await asyncio.wait_for(self.engine.run(AgentRequest(
                    agent_id=head, trigger="approval_review",
                    guild_id=self.cfg.discord_guild_id if row["origin"] == "discord" else None,
                    channel_id=row["channel_id"] or row["origin_channel_id"], thread_id=None, human_user_id=None,
                    text=card, origin=row["origin"], sink=sink, tools_override=("approval_decide", "approval_escalate"),
                    approval_id=str(row["id"]), system_extra=extra, max_output_tokens=400)), REVIEW_TIMEOUT_S)
            elif head is None:
                pass
            else:
                return  # no engine wired (tests/CLI without one): humans decide
        except Exception as e:
            self._log("approval.review_failed", "ERROR", id=str(row["id"]), error=type(e).__name__)
        try:
            cur = await self.pool.fetchrow("SELECT * FROM approvals WHERE id=?1", str(row["id"]))
            if cur is not None and cur["status"] == "pending" and cur["level"] == "dept":
                await self.escalate(cur, "head_no_decision", "agent:system")
        except Exception as e:
            self._log("approval.review_failed", "ERROR", id=str(row["id"]), error=type(e).__name__)

    async def _head_checks(self, row, persona) -> str | None:
        """First failing pre-check token, or None. Re-run server-side on every head action (T031-02)."""
        if not await self.settings.ai_enabled():
            return "ai_disabled"
        if persona.dept in HQ_ONLY:
            return "hq_only"
        if await self.settings.head(code_of(persona.dept)) != persona.id:
            return "not_head"
        pl = row["payload"] or {}
        _, who = await self._linked_task(pl.get("thread"))
        if persona.id in who | await self._chain_creators(pl.get("task")):
            return "task_creator"
        return None

    async def _why(self, cur, persona, thr, cap) -> str:
        if cur["expires_at"] <= await self.pool.fetchval(f"SELECT {NOW}"):
            return "expired"
        n = await self.pool.fetchval(
            "SELECT count(*) FROM audit_log WHERE scope='approval' AND action='ai_decide' AND actor=?1 "
            "AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')", f"agent:{persona.id}")
        for tok, bad in (("level", cur["level"] != "dept"), ("dept", cur["dept"] != code_of(persona.dept)),
                         ("kind", cur["kind"] != "generic"), ("access", cur["access"] != []),
                         ("value", cur["value_thb"] is None or cur["value_thb"] >= thr),
                         ("requester", cur["requested_by"] == persona.id), ("cap", n >= cap)):
            if bad:
                return tok
        return "guard"

    async def decide_as_head(self, approval_id: str, action: ApprovalAction, persona, reason: str) -> str:
        """Structured AI decision. -> approved|rejected|already_decided|escalated|denied|not_found."""
        try:
            aid = str(uuid.UUID(str(approval_id)))
        except ValueError:
            return "not_found"
        row = await self.pool.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)
        if row is None or action not in _STATUS:
            return "not_found"
        if row["status"] != "pending":
            return "already_decided"
        thr, cap = await self.settings.threshold(), await self.settings.ai_daily_max()
        fail = await self._head_checks(row, persona)
        r = None
        if fail is None:
            async with self.pool.transaction() as tx:
                r = await tx.fetchrow(
                    "UPDATE approvals SET status=?2, decided_by='agent:' || ?3, decision_reason=?4, decided_at=" + NOW +
                    " WHERE id=?1 AND status='pending' AND expires_at > " + NOW + " AND level='dept' AND dept=?5"
                    " AND kind='generic' AND access='[]' AND value_thb IS NOT NULL AND value_thb < ?6 AND requested_by != ?3"
                    " AND (SELECT count(*) FROM audit_log WHERE scope='approval' AND action='ai_decide'"
                    " AND actor='agent:' || ?3 AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) < ?7 RETURNING *",
                    aid, _STATUS[action], persona.id, reason, code_of(persona.dept), thr, cap)
                if r is not None:
                    await tx.execute(_AUDIT, r["code"], "ai_decide", "status", "pending", r["status"], f"agent:{persona.id}")
        if r is None:
            cur = await self.pool.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)
            if cur["status"] != "pending":
                return "already_decided"
            why = fail or await self._why(cur, persona, thr, cap)
            self._log("approval.ai_denied", "WARNING", code=cur["code"], agent=persona.id, reason=why)
            return "escalated" if await self.escalate(cur, "head_guard_failed", "agent:system") else "denied"
        self._log("approval.ai_decided", "WARNING", code=r["code"], agent=persona.id, status=r["status"])
        await self._show_decision(r, None)
        self._run_handler_bg(r)
        return r["status"]

    async def escalate_as_head(self, approval_id: str, persona, reason: str) -> str:
        try:
            aid = str(uuid.UUID(str(approval_id)))
        except ValueError:
            return "not_found"
        row = await self.pool.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)
        if row is None:
            return "not_found"
        if row["status"] != "pending":
            return "already_decided"
        fail = await self._head_checks(row, persona)
        if fail is None and row["dept"] != code_of(persona.dept):
            fail = "dept"
        if fail:
            self._log("approval.ai_denied", "WARNING", code=row["code"], agent=persona.id, reason=fail)
            return "denied"
        return "escalated" if await self.escalate(row, "head_escalated", f"agent:{persona.id}", note=reason) else "denied"

    async def escalate(self, row, reason: str, actor_ref: str, note: str | None = None):
        """dept -> hq, same code. New HQ card; the old card is edited to 'Escalated' without buttons."""
        async with self.pool.transaction() as tx:
            r = await tx.fetchrow(
                "UPDATE approvals SET level='hq', route_reason=?2, decision_reason=COALESCE(?3, decision_reason) "
                "WHERE id=?1 AND status='pending' AND level='dept' RETURNING *", str(row["id"]), reason, note)
            if r is not None:
                await tx.execute(_AUDIT, r["code"], "escalate", "route_reason", "dept", reason, actor_ref)
        if r is None:
            return None
        self._log("approval.escalated", "WARNING", code=r["code"], by=actor_ref, reason=reason)
        old = (r["channel_id"], r["message_id"])
        await self._present(r)
        moved = getattr(self.presenter, "show_moved", None)
        if moved is not None and old[0] and old[1]:
            try:
                await moved(old[0], old[1], r)
            except Exception as e:
                self._log("approval.present_failed", "ERROR", id=str(r["id"]), error=type(e).__name__)
        return r

    # -- human decisions (R6) ----------------------------------------------------------------------------
    async def decide(self, approval_id: str, action: ApprovalAction, actor: Actor) -> Decision:
        try:
            aid = str(uuid.UUID(str(approval_id)))
        except ValueError:
            return Decision("not_found")
        if action not in _STATUS:
            return Decision("not_found")

        def deny(reason):
            self._log("approval.denied", "WARNING", id=aid, by=actor.ref, reason=reason)
            return Decision("not_approver")

        if actor.kind != self.policy.surface:
            return deny("surface")
        try:
            ok = await self.policy.is_approver(actor)
        except Exception:
            ok = False  # fail closed
        if not ok:
            return deny("role")
        async with self.pool.transaction() as tx:
            r = await tx.fetchrow(
                "UPDATE approvals SET status=?2, decided_by=?3, decided_at=" + NOW + ", overridden_from = "
                "CASE WHEN status='pending' THEN NULL ELSE decided_by END WHERE id=?1 AND origin=?4 AND expires_at > " + NOW +
                " AND (status='pending' OR (decided_by GLOB 'agent:*' AND status IN ('approved','rejected') AND status != ?2))"
                " RETURNING *", aid, _STATUS[action], actor.ref, actor.kind)
            if r is not None and r["overridden_from"]:
                await tx.execute(_AUDIT, r["code"], "override", "decided_by", r["overridden_from"], actor.ref, actor.ref)
            elif r is not None:
                await tx.execute(_AUDIT, r["code"], "decide", "status", "pending", r["status"], actor.ref)
        if r is None:
            cur = await self.pool.fetchrow("SELECT status, origin FROM approvals WHERE id=?1", aid)
            if cur is None:
                return Decision("not_found")
            if cur["origin"] != actor.kind:
                return deny("origin_mismatch")
            return Decision("already_decided" if cur["status"] != "pending" else "expired")
        row = r
        if row["overridden_from"]:
            self._log("approval.overridden", "WARNING", code=row["code"], by=actor.ref, status=row["status"])
        self._log("approval.decided", id=aid, status=row["status"], by=actor.ref)
        await self._show_decision(row, actor)
        self._run_handler_bg(row)
        return Decision(row["status"], row)

    async def cancel(self, code: str, actor: Actor, reason: str = ""):
        """Soft cancel of a pending approval; the caller has authorised the actor. Returns the row or None."""
        async with self.pool.transaction() as tx:
            r = await tx.fetchrow("UPDATE approvals SET status='cancelled' WHERE code=?1 AND status='pending' RETURNING *", code)
            if r is not None:
                await tx.execute(_AUDIT, code, "cancel", None, "pending", f"cancelled: {reason}" if reason else "cancelled", actor.ref)
        if r is not None:
            self._log("approval.cancelled", code=code, by=actor.ref)
            await self._show_decision(r, actor)
        return r

    def _run_handler_bg(self, row) -> None:
        h = self._handlers.get(row["kind"])
        if h is not None:
            self._spawn(self._run_handler(h, row))

    async def _run_handler(self, h, row) -> None:
        try:
            await h(row)
        except Exception as e:
            self._log("approval.handler_failed", "ERROR", id=str(row["id"]), error=type(e).__name__)

    async def sweep_expired(self) -> int:
        rows = await self.pool.fetch("UPDATE approvals SET status='expired' WHERE status='pending' "
            "AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING *")
        for r in rows:
            await self._show_decision(dict(r), None)
        return len(rows)

    async def recover(self) -> None:
        """T031-09: review tasks are in memory; after a restart re-spawn one for every pending department card.
        The surface calls this once its presenter can post (Discord: intake ready; CLI: after set_presenter)."""
        if getattr(self, "_recovered", False):  # on_ready re-fires on reconnect: one recovery per process (R11 one review run)
            return
        self._recovered = True  # set before the await so overlapping calls cannot both spawn
        try:
            rows = await self.pool.fetch("SELECT * FROM approvals WHERE status='pending' AND level='dept' "
                                         "AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        except Exception:
            self._recovered = False  # a failed recovery may retry on the next ready
            raise
        for r in rows:
            self._spawn(self._review(r))

    async def _sweep_loop(self, interval_s: float) -> None:
        while True:
            try:
                await self.sweep_expired()
            except Exception as e:
                self._log("approval.sweep_failed", "ERROR", error=type(e).__name__)
            await asyncio.sleep(interval_s)

    def start(self, interval_s: float = 60) -> None:
        loop = asyncio.get_running_loop()
        self._sweeper = loop.create_task(self._sweep_loop(interval_s))

    async def stop(self) -> None:
        if self._sweeper:
            self._sweeper.cancel()


def _prompt(cfg, name: str) -> str:
    from pathlib import Path

    from core.config import PROJECT_ROOT
    d = Path(cfg.prompts_dir) if getattr(cfg, "prompts_dir", None) else PROJECT_ROOT / "prompts"
    d = d if d.is_absolute() else PROJECT_ROOT / d
    return (d / "_system" / name).read_text(encoding="utf-8")


def make_generic_handler(ctx):
    """Wakes the requesting agent and shows its reply on the approval's origin channel. Acts only on the DB row (10.13.8)."""
    async def handler(row: dict[str, Any]) -> None:
        verb = "approved" if row["status"] == "approved" else "rejected"
        persona = ctx.personas.get(row["requested_by"]) if getattr(ctx, "personas", None) else None
        sinks, sink, cid = getattr(ctx, "sinks", None), None, row["origin_thread_id"] or row["origin_channel_id"]
        if sinks is not None and persona is not None:
            chan = ctx.bot.get_channel(cid) if getattr(ctx, "bot", None) else cid  # CLI has no bot: sink takes the id
            sink = sinks.for_channel(chan, persona) if chan is not None else None
        await ctx.engine.run(AgentRequest(
            agent_id=row["requested_by"], trigger="approval_decided",
            guild_id=ctx.config.discord_guild_id if row["origin"] == "discord" else None,
            channel_id=row["origin_channel_id"], thread_id=row["origin_thread_id"], human_user_id=None,
            text=f"{row['title']} was {verb} by {row['decided_by']}", origin=row["origin"], sink=sink))
    return handler
