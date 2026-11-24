"""Extension entry (REQUIRED, spec 10.0): builds providers, tool registry (+ respond) and the engine."""
from core.agent_tools.registry import Registry
from core.agent_tools.respond import make_respond
from core.agents.engine import Engine
from core.interfaces import AppContext


def init(ctx: AppContext) -> None:
    c = ctx.config
    if c.anthropic_api_key and "anthropic" not in ctx.providers:
        from core.provider.anthropic.adapter import AnthropicAdapter
        ctx.providers["anthropic"] = AnthropicAdapter(c.anthropic_api_key)
    if c.google_api_token and "google" not in ctx.providers:
        from core.provider.google.adapter import GoogleAdapter
        ctx.providers["google"] = GoogleAdapter(c.google_api_token)
    ctx.tools = Registry(ctx.log)
    ctx.tools.register(make_respond(ctx))
    ctx.engine = Engine(ctx)
