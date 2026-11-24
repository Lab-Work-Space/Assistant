"""Provider model strings (spec 3.2) and the opt-in model-list check (TASK-010 acceptance 7)."""
from core.interfaces import ProviderError

_PREFIX = {"anthropic": "anthropic", "google": "google", "gemini": "google"}


def parse_model(s: str) -> tuple[str, str]:
    """'<provider>/<model-id>' -> (provider key, model id). 'gemini' is an alias of 'google'."""
    prov, _, mid = s.partition("/")
    if prov not in _PREFIX or not mid:
        raise ProviderError("model_not_found")
    return _PREFIX[prov], mid


def configured_models(ctx) -> list[str]:
    c = ctx.config
    out = {m for p in ctx.personas.all() for m in (p.model, p.cheap_model)}
    out |= {c.default_cheap_model, c.reply_tier2_model, c.image_model, c.tts_model}
    return sorted(m for m in out if m.partition("/")[0] in _PREFIX)


async def verify_models(ctx) -> None:
    """Opt-in startup check (call when EMP_VERIFY_MODELS=1): every configured id must be in the provider's list.
    Raises ProviderError('model_not_found') whose message lists the unknown ids (config values, not secrets)."""
    known: dict[str, set[str]] = {}
    missing = []
    for m in configured_models(ctx):
        prov, mid = parse_model(m)
        if prov not in ctx.providers:
            continue  # no key configured for this provider; nothing to check against
        if prov not in known:
            known[prov] = await ctx.providers[prov].list_models()
        if mid not in known[prov]:
            missing.append(m)
    if missing:
        raise ProviderError("model_not_found", "unknown_models:" + ",".join(missing))
