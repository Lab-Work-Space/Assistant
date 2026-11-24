"""Approval routing (spec R4): first matching rule sends the card to HQ; otherwise it stays at department level.
The classifier (rule 9) runs only when rules 1-8 did not match, and never inside a DB transaction (T031-08)."""
import asyncio
from pathlib import Path

from core.agents.untrusted import wrap_untrusted
from core.approvals.depts import DEPT_CODES, HQ_ONLY, code_of
from core.budget.guard import GATE
from core.config import PROJECT_ROOT
from core.provider.registry import parse_model


class Router:
    def __init__(self, settings, personas, classify, log):
        self.settings, self.personas, self.classify, self.log = settings, personas, classify, log

    async def route(self, *, kind, access, value_thb, other_depts, requested_by, dept_slug, involved, card, aid):
        """-> (level, dept_code, route_reason). card: dict for the classifier."""
        s, code = self.settings, code_of(dept_slug)

        def hq(reason):
            return "hq", code, reason
        if kind != "generic":
            return hq("kind_dangerous")
        if access:
            return hq("access_requested")
        if value_thb is not None and value_thb >= await s.threshold():
            return hq("value_over_threshold")
        if any(d != dept_slug for d in other_depts):
            return hq("cross_dept")
        if dept_slug in HQ_ONLY or dept_slug not in DEPT_CODES:
            return hq("no_dept")
        head = await s.head(code)
        if head is None or self.personas is None or self.personas.get(head) is None or s.is_disabled(head):
            return hq("no_head")
        if head == requested_by or head in involved:  # T031-02/G2T031-02: head created/owns/joined the task chain or brainstorm
            return hq("requester_is_head")
        if not await s.ai_enabled():
            return hq("ai_disabled")
        try:
            out = await self.classify(card, aid)
        except Exception as e:  # type only: exception text may carry secrets (T031-04c)
            self.log.write_log("approvals", "approval.classify_failed", "WARNING", error=type(e).__name__)
            return hq("classifier_unavailable")
        if out is None:
            return hq("classifier_unavailable")
        return hq("classifier_major") if out != "routine" else ("dept", code, "dept_routine")


def _clip(v, budget=4000) -> str:
    """Whole value up to the budget (= summary max); beyond it head+tail so the middle cannot hide the end (G2T031-03)."""
    v = str(v)
    return v if len(v) <= budget else v[:budget // 2] + " ... " + v[-budget // 2:]


def make_classifier(ctx):
    """Reply-gate tier2 pattern: cheap model, 8 output tokens, billed to the gate agent with purpose 'tier2'."""
    system = []

    async def classify(card: dict, aid: str) -> str | None:
        c = ctx.config
        if await ctx.budget.level(GATE) in ("fallback", "stop"):
            return None
        prov, model = parse_model(c.reply_tier2_model)
        adapter = ctx.providers.get(prov)
        if adapter is None:
            return None
        if not system:
            d = Path(c.prompts_dir)
            d = d if d.is_absolute() else PROJECT_ROOT / d
            system.append((d / "_system" / "approval-classifier.md").read_text(encoding="utf-8"))
        text = "\n".join(f"{k}: {_clip(card.get(k))}" for k in ("title", "summary", "reason", "value_thb", "priority"))
        out, usage = await asyncio.wait_for(
            adapter.complete(model=model, system=system[0], prompt=wrap_untrusted(text, "approval"), max_output_tokens=8,
                             timeout_s=c.reply_tier2_timeout_s), c.reply_tier2_timeout_s + 1)
        await ctx.budget.record(GATE, prov, model, usage, "tier2", ref=f"approval:{aid}")
        return out.strip()
    return classify
