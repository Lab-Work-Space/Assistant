"""Real BudgetGuard (spec 3.11 + 10.2). Fails closed: any lookup error gives level 'stop'; record never raises."""
import math
from datetime import datetime
from decimal import Decimal
from typing import Awaitable, Callable
from zoneinfo import ZoneInfo

from core.budget import prices, repo
from core.interfaces import Actor, BudgetLevel, SetLimitOutcome, Usage

GATE = "_gate"
# (agent_id, level, spent_micro, limit_micro); level in warn80|fallback100|stop120. 018B wires the Discord one.
Notifier = Callable[[str, str, int, int], Awaitable[None]]
_NOTICE = {"warn": "warn80", "fallback": "fallback100", "stop": "stop120"}


class Guard:
    def __init__(self, ctx, notifier: Notifier | None = None) -> None:
        self.ctx, self.notifier = ctx, notifier
        self._unrecorded: dict[tuple[str, object], int] = {}
        self._warned: set[str] = set()

    def _log(self, event: str, level: str = "INFO", **f) -> None:
        self.ctx.log.write_log("budget", event, level, **f)

    def _day(self):
        return datetime.now(ZoneInfo(self.ctx.config.app_timezone)).date()

    async def level(self, agent_id: str) -> BudgetLevel:
        try:
            day = self._day()
            c = self.ctx.config
            lim = await repo.limit(self.ctx.db, agent_id)
            if lim is None:
                lim = int((c.budget_gate_daily_usd if agent_id == GATE else c.budget_default_daily_usd) * 1_000_000)
            spent = await repo.spent(self.ctx.db, agent_id, day) + self._unrecorded.get((agent_id, day), 0)
            pct = spent * 100
            lvl: BudgetLevel = ("stop" if pct >= 120 * lim else "fallback" if pct >= 100 * lim
                                else "warn" if pct >= 80 * lim else "ok")
            if lvl != "ok":
                await self._notice(agent_id, day, lvl, spent, lim)
            return lvl
        except Exception as e:
            self._log("budget.level_error", "ERROR", agent=agent_id, error=type(e).__name__)
            return "stop"

    async def _notice(self, agent_id, day, lvl, spent, lim) -> None:
        try:
            if await repo.first_notice(self.ctx.db, agent_id, day, _NOTICE[lvl]) and self.notifier:
                await self.notifier(agent_id, _NOTICE[lvl], spent, lim)
        except Exception as e:  # a failed notice must not change the level
            self._log("budget.notice_failed", "ERROR", agent=agent_id, error=type(e).__name__)

    def _cost(self, model: str, usage: Usage, purpose: str, units: int) -> int:
        if purpose in prices.UNIT:
            p, known = prices.unit_price(purpose, model.split("/", 1)[-1])  # price key has no provider/ prefix
            cost = units * p
        else:
            (pin, pout), known = prices.token_price(model)
            cost = math.ceil((usage.input_tokens * pin + usage.output_tokens * pout) / 1_000_000)
        if not known and model not in self._warned:
            self._warned.add(model)
            self._log("budget.unknown_model", "WARNING", model=model)
        return cost

    async def record(self, agent_id: str, provider: str, model: str, usage: Usage, purpose: str,
                     units: int = 0, ref: str | None = None) -> None:
        try:
            cost = self._cost(model, usage, purpose, units)
        except Exception:  # e.g. unknown purpose: charge the worst case rather than nothing
            cost = prices.UNIT["image"]["default"]
        day = self._day()
        try:
            await repo.insert_usage(self.ctx.db, agent_id, day, provider, model, purpose,
                                    usage.input_tokens, usage.output_tokens, units, cost, ref)
        except Exception:
            self._unrecorded[(agent_id, day)] = self._unrecorded.get((agent_id, day), 0) + cost
            self._log("budget.record_failed", "ERROR", agent=agent_id, provider=provider, model=model,
                      purpose=purpose, input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
                      units=units, cost_micro_usd=cost)

    async def set_limit(self, agent_id: str, usd: Decimal, actor: Actor) -> SetLimitOutcome:
        try:
            ok = actor.kind == self.ctx.approver_policy.surface and await self.ctx.approver_policy.is_approver(actor)  # G2-07
        except Exception:
            ok = False
        if not ok:
            return "not_approver"
        if agent_id != GATE and self.ctx.personas.get(agent_id) is None:
            return "invalid_agent"
        if not (Decimal("0.01") <= usd <= Decimal("1000")):
            return "out_of_range"
        await repo.upsert_limit(self.ctx.db, agent_id, int(usd * 1_000_000), actor.ref)
        self._log("budget.set", agent=agent_id, by=actor.ref, limit=str(usd))
        return "ok"
