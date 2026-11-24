"""image_generate tool (spec 3.4, 10.2.4). Fixed error strings only; never logs the prompt."""
from core.interfaces import ProviderError, ToolContext, ToolResult, ToolSpec, Usage

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["prompt"],
    "properties": {"prompt": {"type": "string", "minLength": 1, "maxLength": 2000},
                   "aspect": {"enum": ["1:1", "16:9", "9:16"]}},
}


def make_image_generate(app) -> ToolSpec:
    async def handler(ctx: ToolContext, a: dict) -> ToolResult:
        model = app.config.image_model
        ad = app.providers.get("google")
        if ad is None:
            return ToolResult(ok=False, error="image_failed")
        if await app.budget.level(ctx.agent.id) in ("fallback", "stop"):  # no cheaper image model
            return ToolResult(ok=False, error="budget_exhausted")
        try:
            data = await ad.generate_image(model=model, prompt=a["prompt"], aspect=a.get("aspect", "1:1"),
                                           timeout_s=90.0)
        except ProviderError:  # transport error before any response: nothing recorded
            return ToolResult(ok=False, error="image_failed")
        # a response arrived (even a safety block): it is billed
        await app.budget.record(ctx.agent.id, "google", model, Usage(), "image", units=1, ref=ctx.run_id)
        if data is None:
            return ToolResult(ok=False, error="image_blocked")
        mid = await ctx.sink.send_file("image.png", data)
        return ToolResult(ok=True, data={"message_id": mid})

    return ToolSpec(name="image_generate", description=(
        "Generate an image from a text prompt and post it as an attachment. aspect: 1:1, 16:9 or 9:16."),
        parameters=SCHEMA, handler=handler, timeout_s=90.0)


def init(ctx) -> None:
    ctx.tools.register(make_image_generate(ctx))
