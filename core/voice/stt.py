"""STT adapters (spec 12.12.10). In-process, per chunk, bytes only in memory. Returns (text, billed_seconds)."""
import asyncio
import base64
import io
import json
import math
import urllib.request
import wave

from core.interfaces import ProviderError

BYTES_PER_S = 32000  # 16 kHz mono s16le
PROMPT = ("Transcribe this audio verbatim. The language is Thai, possibly with English words. "
          "Output only the transcript text. If there is no speech, output nothing.")


def seconds_of(pcm: bytes) -> int:
    return max(1, math.ceil(len(pcm) / BYTES_PER_S))


def to_wav(pcm: bytes) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)
    return b.getvalue()


class GeminiStt:
    name = "gemini"

    def __init__(self, adapter, model: str, timeout_s: float = 60):
        self.adapter, self.model, self.timeout_s = adapter, model, timeout_s

    async def transcribe(self, pcm: bytes) -> tuple[str, int]:
        text, _ = await self.adapter.transcribe_audio(model=self.model, audio=to_wav(pcm), mime="audio/wav",
                                                      prompt=PROMPT, timeout_s=self.timeout_s)
        return text.strip(), seconds_of(pcm)


class CloudStt:
    """Cloud Speech-to-Text v1 REST. The key goes in a header only and is never logged."""
    name = "google-stt"
    URL = "https://speech.googleapis.com/v1/speech:recognize"

    def __init__(self, api_key: str, urlopen=urllib.request.urlopen, timeout_s: float = 60):
        self._key, self._urlopen, self.timeout_s = api_key, urlopen, timeout_s

    def _post(self, body: bytes) -> dict:
        req = urllib.request.Request(self.URL, data=body, method="POST", headers={
            "x-goog-api-key": self._key, "Content-Type": "application/json"})
        with self._urlopen(req, timeout=self.timeout_s) as r:
            return json.loads(r.read())

    async def transcribe(self, pcm: bytes) -> tuple[str, int]:
        body = json.dumps({"config": {"encoding": "LINEAR16", "sampleRateHertz": 16000, "languageCode": "th-TH",
                                      "alternativeLanguageCodes": ["en-US"]},
                           "audio": {"content": base64.b64encode(pcm).decode()}}).encode()
        try:
            out = await asyncio.to_thread(self._post, body)
        except Exception as e:  # never include e's text (URL/headers)
            code = getattr(e, "code", None)
            raise ProviderError("auth" if code in (401, 403) else "rate_limited" if code == 429 else "unavailable",
                                retryable=code is None or code == 429 or code >= 500) from None
        text = " ".join((r.get("alternatives") or [{}])[0].get("transcript", "") for r in out.get("results", []))
        return text.strip(), seconds_of(pcm)


def make_stt(ctx):
    c = ctx.config
    if c.stt_provider == "google-stt":
        return CloudStt(c.google_stt_api_key)
    return GeminiStt(ctx.providers["google"], c.stt_model.split("/", 1)[-1])
