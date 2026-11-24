"""Optional live smoke (costs money). Run only with EMP_LIVE_SMOKE=1 and keys in the process env:
  EMP_LIVE_SMOKE=1 ANTHROPIC_API_KEY=... GOOGLE_API_TOKEN=... python tools/smoke/live_provider_smoke.py"""
import asyncio
import os
import sys

from core.provider.anthropic.adapter import AnthropicAdapter
from core.provider.google.adapter import GoogleAdapter


async def main() -> None:
    for name, ad, model in (("anthropic", AnthropicAdapter(os.environ.get("ANTHROPIC_API_KEY")), "claude-haiku-5-5"),
                            ("google", GoogleAdapter(os.environ.get("GOOGLE_API_TOKEN")), "gemini-3.8-flash")):
        print(name, "model listed:", model in await ad.list_models())
        text, usage = await ad.complete(model=model, system="", prompt="Say ok.", max_output_tokens=64, timeout_s=30)
        print(name, "complete ok, tokens:", usage.input_tokens, usage.output_tokens, "chars:", len(text))


if os.environ.get("EMP_LIVE_SMOKE") != "1":
    sys.exit("set EMP_LIVE_SMOKE=1 to run")
asyncio.run(main())
