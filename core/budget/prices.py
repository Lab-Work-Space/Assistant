"""Prices in micro-USD. Token models: (per 1M input, per 1M output). Unit models: per image / TTS char / STT second.
Sources checked 2026-11-24: Anthropic model table (cached 2026-11-03) and aistudio.google.com/docs/pricing (paid tier).
Gemini 3.8 Flash and TTS use the list price that starts 2027-01-01 (2x the 2026 promo) so budgets never under-count.
shortcut: STT price and the TTS per-char conversion are estimates, verify after TASK-002."""
TOKEN = {
    "gemini-3.8-flash": (1_500_000, 7_500_000),       # $0.75 / $3.75 until 2026-12-31
    "gemini-3.1-flash-lite": (250_000, 1_500_000),
    "claude-opus-5-5": (4_000_000, 20_000_000),
    "claude-sonnet-5-5": (2_000_000, 10_000_000),
    "claude-haiku-5-5": (100_000, 500_000),            # prompts <= 100K tokens ($0.50 / $2.50 beyond)
}
UNIT = {
    "image": {"default": 67_000, "gemini-3.1-flash-image": 67_000},  # 1K image $0.067 (2K $0.101, 4K $0.151)
    "tts": {"default": 30, "gemini-3.8-flash-tts": 30},
    "stt": {"default": 100, "gemini-3.8-flash": 100, "cloud-stt-v1": 400},  # assumed; verify after TASK-002
}
_MAX_TOKEN = (max(p[0] for p in TOKEN.values()), max(p[1] for p in TOKEN.values()))


def token_price(model: str) -> tuple[tuple[int, int], bool]:
    """Returns (price, known). Unknown model is charged the highest price in the table."""
    p = TOKEN.get(model)
    return (p, True) if p else (_MAX_TOKEN, False)


def unit_price(purpose: str, model: str) -> tuple[int, bool]:
    t = UNIT[purpose]
    p = t.get(model)
    return (p, True) if p is not None else (max(t.values()), False)
