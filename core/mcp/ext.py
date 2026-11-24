"""Extension entry: builds the host and gateway, sets ctx.mcp. Any failure leaves MCP off (not REQUIRED)."""
import asyncio
import logging
from pathlib import Path

from core.config import PROJECT_ROOT

log = logging.getLogger(__name__)


def init(ctx) -> None:
    try:
        _init(ctx)
    except Exception as e:
        ctx.mcp = None
        log.warning("mcp.init_failed %s", type(e).__name__)


def _init(ctx) -> None:
    from core.approvals.service import make_generic_handler
    from core.mcp.gateway import Gateway
    from core.mcp.host import McpHost
    from core.mcp.policy import load_access, load_policy

    if ctx.approvals is None or ctx.tools is None or ctx.settings is None:
        return
    root = PROJECT_ROOT / "mcp"
    pols = {}
    for f in sorted(root.glob("*/policy.toml")):
        sp = load_policy(f)
        pols[sp.service] = sp.tools
    access = load_access(root / "access.toml")
    data_dir = Path(ctx.config.database_path).parent
    host = McpHost(root, data_dir, ctx.log, pols)
    import os
    gw = Gateway(ctx, host, pols, access, environ=os.environ)
    gw.generic = make_generic_handler(ctx)
    ctx.tools.register(gw.use_spec())
    ctx.approvals.register_handler("mcp_irreversible", gw.replay)
    ctx.mcp = gw
    state = {"started": False}
    orig_recover, orig_stop = ctx.approvals.recover, ctx.approvals.stop

    async def recover():
        first = not state["started"]
        if first:
            state["started"] = True
            await host.start()
        await orig_recover()
        if first:  # a Discord reconnect re-runs recover(); a claimed in-flight replay must not be flipped to unknown
            await gw.recover()

    async def stop():
        await orig_stop()
        await host.stop()

    ctx.approvals.recover, ctx.approvals.stop = recover, stop
