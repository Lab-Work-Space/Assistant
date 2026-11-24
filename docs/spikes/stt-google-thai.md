# Spike: STT accuracy, Thai (TASK-002)
Date: <fill> | Tool: tools/spikes/stt | Providers: Gemini (google-genai inline audio) and Google Cloud STT v1 th-TH (+ en-US alt for mixed) | Threshold: average CER <= 10%

## Per-clip results
| # | Clip type (Thai / mixed) | Audio s | Gemini CER | Gemini latency s | Cloud STT CER | Cloud STT latency s |
|---|---|---|---|---|---|---|
| 1 | Thai | | | | | |
| ... | | | | | | |
| 11 | mixed | | | | | |

- Clips: <n> Thai, <n> mixed (10-60 s). Source: production sink (if the probe passed) / phone recordings. Speakers: <n>.

## Summary per provider
| Provider | Avg CER all | Thai only | Mixed only | Avg latency s | Max latency s | Cost/min (est.) | Verdict (avg CER <= 10%) |
|---|---|---|---|---|---|---|---|
| gemini | | | | | | | |
| google-stt | | | | | | | |

- Decision: default = provider with average CER <= 10%; both pass and within 2 points -> keep `gemini`; neither -> NO-GO, escalate (TASK-016 blocked).
- Chosen `STT_PROVIDER`: <gemini|google-stt|NO-GO>

## DAVE receive probe (allowlisted test channel, >= 3 humans, 30 s each; py-cord 2.8.1)
`vc.is_dave_connection()`: <true|false>

| Check | Result | Notes |
|---|---|---|
| (a) PCM frames > 0 for every speaker | PASS / FAIL | frames per speaker: <n, n, n> |
| (b) no router/decoder exception (`after(error)` is None) | PASS / FAIL | |
| (c) WAV intelligible to a human AND CER within 5 points of phone reference clips | PASS / FAIL | probe-WAV CER <x>% vs phone <y>% |

- Result: PASS -> `VOICE_LIVE_CAPTURE` may be enabled / FAIL -> live capture stays off; B2 ships join + TTS only (OQ-20).

## Playback probe (5 s Gemini TTS via MonoPcmSource)
| Item | Result |
|---|---|
| Response `mime_type` (parsed) | <e.g. audio/L16;codec=pcm;rate=24000> |
| Humans hear it clearly | PASS / FAIL |

## VPS resources (capture running, >= 3 speakers)
| Metric | Idle | During capture | Limit |
|---|---|---|---|
| CPU % (process) | | | |
| RSS MB | | | |

- Observations (error patterns, mixed-language behaviour; no verbatim transcripts):

Confirm: no secrets, raw audio, user ids or transcripts in this report; audio deleted after scoring.
