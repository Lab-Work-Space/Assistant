"""THROWAWAY spike (TASK-002). CER vs <clip>.ref.txt. Usage: python score.py [clips_dir] [--keep] [--usd-per-min X]
Deletes .wav after scoring unless --keep. python score.py --selftest runs offline asserts."""
import glob, json, os, sys, unicodedata

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "clips")
THRESHOLD = 0.10


def norm(s):  # Thai has no word spaces: drop whitespace/punctuation, lowercase Latin
    # keep letters/digits/combining marks (Thai vowels/tones are Mn; \w would drop them)
    return "".join(c for c in s.lower() if unicodedata.category(c)[0] in "LMN")


def cer(ref, hyp):
    r, h = norm(ref), norm(hyp)
    if not r:
        raise ValueError("empty reference")
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i]
        for j, hc in enumerate(h, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / len(r)


def selftest():
    assert cer("abc", "abc") == 0
    assert cer("abcd", "abxd") == 0.25            # 1 substitution / 4
    assert cer("abcd", "abd") == 0.25             # 1 deletion
    assert cer("ab", "abcd") == 1.0               # 2 insertions / 2
    assert cer("A b, c", "abc") == 0              # normalisation
    assert cer("สวัสดีครับ", "สวัสดีครับ") == 0
    assert cer("สวัสดีครับ", "สวัสดีคับ") == 1 / 10  # 1 deletion of ร; marks counted (10 code points)
    assert cer("ไป กิน ข้าว", "ไปกินข้าว") == 0      # Thai spaces ignored
    assert cer("สวัสดี", "") == 1.0
    print("selftest OK")


def main():
    a = sys.argv[1:]
    keep = "--keep" in a
    rate = float(a.pop(a.index("--usd-per-min") + 1)) if "--usd-per-min" in a else 0.024
    if "--usd-per-min" in a: a.remove("--usd-per-min")
    a = [x for x in a if x != "--keep"]
    d = a[0] if a else D
    meta = json.load(open(os.path.join(d, "results.json")))
    rows = []
    for name, m in sorted(meta.items()):
        base = os.path.join(d, name[:-4])
        if not (os.path.exists(base + ".ref.txt") and os.path.exists(base + ".hyp.txt")):
            print(f"SKIP {name}: missing .ref.txt or .hyp.txt"); continue
        c = cer(open(base + ".ref.txt", encoding="utf-8").read(), open(base + ".hyp.txt", encoding="utf-8").read())
        rows.append((name, c, m["latency_s"], m["duration_s"]))
    print("| clip | CER | latency s | audio s |\n|---|---|---|---|")
    for n, c, l, s in rows:
        print(f"| {n} | {c:.1%} | {l} | {s} |")
    if not rows:
        sys.exit("nothing scored")
    avg = sum(r[1] for r in rows) / len(rows)
    mins = sum(r[3] for r in rows) / 60
    print(f"\nclips={len(rows)} avg CER={avg:.1%} avg latency={sum(r[2] for r in rows)/len(rows):.2f}s")
    print(f"audio={mins:.2f} min, est cost=${mins*rate:.3f} at ${rate}/min (verify current Google pricing)")
    print("VERDICT:", "GO" if avg <= THRESHOLD else f"NO-GO (> {THRESHOLD:.0%}): list alternatives, escalate")
    if not keep:
        for f in glob.glob(os.path.join(d, "*.wav")):
            os.remove(f)
        print("audio deleted")


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
