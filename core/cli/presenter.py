"""CliApprovalPresenter (spec 10.15): prints approval requests and decisions."""
from core.cli.sink import Out


class CliApprovalPresenter:
    def __init__(self, out: Out):
        self.out = out

    async def show_request(self, approval):
        self.out.line(f"[approval {approval['id']}] {approval['title']} (by {approval['requested_by']})")
        self.out.line(f"  code: {approval.get('code', '-')} level: {approval.get('level', '-')} routing: {approval.get('route_reason', '-')}")
        self.out.line(f"  {approval['summary']}")
        if approval.get("access"):
            self.out.line("  access: " + ", ".join(approval["access"]))
        self.out.line("  -> /approve or /reject " + str(approval["id"]))
        return None, None

    async def show_decision(self, approval, actor):
        who = actor.ref if actor else "expiry"
        self.out.line(f"[approval {approval['id']}] {approval['status']} by {who}")
