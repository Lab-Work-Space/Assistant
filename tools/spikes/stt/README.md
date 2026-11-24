# THROWAWAY: Thai STT spike (TASK-002)
Delete this folder after the verdict. Not production code. Never commit `data/`.

## Setup
1. `pip install -r requirements.txt` (py-cord with voice, google-genai; needs libopus: `brew install opus`; no ffmpeg). Run tools from the repo root with the repo venv (`python -m tools.spikes.stt.recorder`) because the recorder imports `core.voice`.
2. Discord Developer Portal: create a test bot. No privileged intents needed (code uses Guilds + Voice States only).
   Invite with scopes `bot` + `applications.commands`, permissions: View Channel, Connect, Send Messages. Use a private test server/channel.
3. Cloud STT only: enable "Cloud Speech-to-Text API" on a project, create an API key restricted to that API.
4. Env vars (names only): `DISCORD_BOT_TOKEN`, `GOOGLE_API_TOKEN` (Gemini key; also Cloud STT key unless `GOOGLE_STT_API_KEY` is set; never printed).

## Run (humans)
1. `python recorder.py` (bot stays online).
2. Everyone joins the test voice channel (>= 3 humans, ~30 s each). Run `/stt-record start`; a notice is posted, then 10 s later everyone present is captured. On `/stt-record stop` the bot logs and posts DAVE status, frames per speaker and `after(error)`; record the (a)(b)(c) DAVE probe result in the report. `/stt-play` plays Gemini TTS and logs `mime_type`.
3. One person speaks one clip (10-60 s; do 10+ Thai clips and 3+ mixed Thai/English), then `/stt-record stop`.
   Each start/stop produces one WAV per speaker in `data/clips/<session>_u<N>.wav`. Repeat start/stop per clip. Keep clips under 59 s.
4. `python transcribe.py --provider gemini` (phone files m4a/aac/mp3/ogg/flac/wav go as they are) and `--provider google-stt` (wav only; convert phone files on the Mac with `afconvert -f WAVE -d LEI16@16000 -c 1 in.m4a out.wav`). Run + score one provider at a time (`results.json` and `.hyp.txt` are overwritten; use `score.py --keep`). (add `--alt en-US` for the mixed clips: run those in a separate dir, e.g. `python transcribe.py data/mixed --alt en-US`). Writes `<clip>.hyp.txt` and `results.json`.
5. Write references: for each `X.wav` create `X.ref.txt` in the same folder = the transcript you listened to and corrected by hand
   (copy `X.hyp.txt`, fix every error; write what was actually said, including English words as spoken). Punctuation/spaces are ignored in scoring.
   Clips with the speaker's `u<N>` containing other people's speech: re-record, one speaker per clip.
6. `python score.py` (prints per-clip CER, average, cost estimate, GO/NO-GO at CER <= 10%, then deletes all `.wav`). Add `--keep` to keep audio for re-runs; delete manually later.
   Offline check of the scorer: `python score.py --selftest`.
7. Fill `docs/spikes/stt-google-thai.md` with the table (no raw audio, no transcripts, no secrets). Then delete `data/` (hyp/ref texts too).

## Notes
- Clips <= 60 s. Cost uses a default $0.024/min (Cloud STT list price): verify current pricing; Gemini cost is estimated from tokens in the report.
- Recorder keeps no user IDs on disk. Only record people who consented.
