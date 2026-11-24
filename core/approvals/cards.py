"""Shared card validator for approval_request and task_create (spec R7). Returns an error string or None."""
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

from core.approvals.depts import DEPT_CODES

CARD_REQUIRED = ("reason", "value_thb", "priority", "due")
TASK_REQUIRED = ("description", "priority", "due", "value_thb")
_DUE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
MAX_DAYS = 730


def _blank(v) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def check_due(due: str, tz: str) -> str | None:
    """Reason token (format|past|too_far) or None."""
    if not isinstance(due, str) or not _DUE.fullmatch(due):
        return "format"
    try:
        d = date.fromisoformat(due)
    except ValueError:
        return "format"
    today = datetime.now(ZoneInfo(tz)).date()
    return "past" if d < today else "too_far" if (d - today).days > MAX_DAYS else None


def check_card(a: dict, required: tuple, tz: str, personas=None) -> str | None:
    missing = [k for k in required if _blank(a.get(k))]
    if missing:
        return "incomplete_card missing=" + ",".join(missing)
    field = "description" if "description" in required else "summary"
    if field in a and len(str(a.get(field) or "").strip()) < 20:
        return f"invalid_field field={field} reason=too_short"
    if a.get("due") is not None and (r := check_due(a["due"], tz)):
        return f"invalid_field field=due reason={r}"
    if a.get("assignee") and personas is not None and personas.get(a["assignee"]) is None:
        return "invalid_field field=assignee reason=unknown"
    if any(s not in DEPT_CODES for s in a.get("other_depts") or ()):
        return "invalid_field field=other_depts reason=unknown"
    return None
