"""THROWAWAY spike (TASK-002). Usage: python transcribe.py [clips_dir] [--provider gemini|google-stt] [--alt en-US]
gemini (default): google-genai, file sent as-is as inline bytes (wav/m4a/aac/mp3/ogg/flac), model env GEMINI_STT_MODEL.
google-stt: Cloud STT v1 REST th-TH, wav only (convert phone files with afconvert), key GOOGLE_STT_API_KEY or GOOGLE_API_TOKEN.
Writes <clip>.hyp.txt and results.json (overwritten per run: run + score one provider at a time, score.py --keep). Needs GOOGLE_API_TOKEN (API key)."""
import array, base64, glob, json, os, sys, time, urllib.request, wave

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "clips")
URL = "https://speech.googleapis.com/v1/speech:recognize"


def mono16(path):
    with wave.open(path) as w:
        ch, rate, n = w.getnchannels(), w.getframerate(), w.getnframes()
        a = array.array("h", w.readframes(n))
    if ch > 1:  # shortcut: plain channel average, fine for Discord stereo
        a = array.array("h", (sum(a[i:i + ch]) // ch for i in range(0, len(a), ch)))
    return a.tobytes(), rate, n / rate


EXT = {".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".mp3": "audio/mp3",
       ".ogg": "audio/ogg", ".flac": "audio/flac"}
PROMPT = "Transcribe this audio verbatim. Thai with possible English words. Output only the transcript, no commentary."


def duration(path):
    try:
        with wave.open(path) as w:
            return w.getnframes() / w.getframerate()
    except Exception:  # non-wav: unknown without ffmpeg
        return 0.0


def gemini(client, path):
    from google.genai import types
    mime = EXT[os.path.splitext(path)[1].lower()]
    r = client.models.generate_content(
        model=os.environ.get("GEMINI_STT_MODEL", "gemini-2.5-flash"),
        contents=[PROMPT, types.Part.from_bytes(data=open(path, "rb").read(), mime_type=mime)])
    return (r.text or "").strip()


def main():
    args = sys.argv[1:]
    prov = args.pop(args.index("--provider") + 1) if "--provider" in args else "gemini"
    if "--provider" in args: args.remove("--provider")
    if prov not in ("gemini", "google-stt"): sys.exit("--provider gemini|google-stt")
    alt = args.pop(args.index("--alt") + 1) if "--alt" in args else None
    if alt: args.remove("--alt")
    d = args[0] if args else D
    if prov == "gemini":
        from google import genai
        client = genai.Client(api_key=os.environ["GOOGLE_API_TOKEN"])
        files = sorted(p for p in glob.glob(os.path.join(d, "*")) if os.path.splitext(p)[1].lower() in EXT)
    else:
        key = os.environ.get("GOOGLE_STT_API_KEY") or os.environ["GOOGLE_API_TOKEN"]
        files = sorted(glob.glob(os.path.join(d, "*.wav")))
    res = {}
    for p in files:
        name = os.path.basename(p)
        if prov == "gemini":
            t = time.time()
            try:
                hyp = gemini(client, p)
            except Exception as e:  # never print the request
                print(f"FAIL {name}: {type(e).__name__}"); continue
            lat, dur = time.time() - t, duration(p)
            open(os.path.splitext(p)[0] + ".hyp.txt", "w", encoding="utf-8").write(hyp)
            res[name] = {"provider": prov, "latency_s": round(lat, 2), "duration_s": round(dur, 1)}
            print(f"{name}: {lat:.2f}s for {dur:.1f}s audio"); continue
        pcm, rate, dur = mono16(p)
        if dur > 59:  # sync API limit is ~60 s
            print(f"SKIP {name}: {dur:.0f}s > 59s"); continue
        cfg = {"encoding": "LINEAR16", "sampleRateHertz": rate, "languageCode": "th-TH"}
        if alt: cfg["alternativeLanguageCodes"] = [alt]
        body = json.dumps({"config": cfg, "audio": {"content": base64.b64encode(pcm).decode()}}).encode()
        req = urllib.request.Request(URL, body, {"Content-Type": "application/json", "x-goog-api-key": key})
        t = time.time()
        try:
            r = json.load(urllib.request.urlopen(req, timeout=120))
        except Exception as e:  # never print the request (contains key header)
            print(f"FAIL {name}: {type(e).__name__} {getattr(e, 'code', '')}"); continue
        lat = time.time() - t
        hyp = "".join(x["alternatives"][0]["transcript"] for x in r.get("results", []))
        open(p[:-4] + ".hyp.txt", "w", encoding="utf-8").write(hyp)
        res[name] = {"provider": prov, "latency_s": round(lat, 2), "duration_s": round(dur, 1)}
        print(f"{name}: {lat:.2f}s for {dur:.1f}s audio")
    json.dump(res, open(os.path.join(d, "results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
