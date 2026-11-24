"""Prices in micro-USD. Token models: (per 1M input, per 1M output). Unit models: per image / TTS char / STT second.
shortcut: placeholder list prices, review against the providers' price pages before go-live."""
TOKEN = {
    "gemini-3.8-flash": (300_000, 2_500_000),
    "gemini-3.1-flash-lite": (100_000, 400_000),
    "claude-opus-5-5": (15_000_000, 75_000_000),
    "claude-sonnet-5-5": (3_000_000, 15_000_000),
    "claude-haiku-5-5": (1_000_000, 5_000_000),
}
UNIT = {
    "image": {"default": 40_000, "gemini-3.1-flash-image": 40_000},
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
