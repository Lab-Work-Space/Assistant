"""G1 fixed routing rules for lessons (R12, G033-02/03). Pure code: no AI decides whether a lesson goes to HQ."""
import re
import unicodedata

from core.agents.persona import normalise

HQ_CATEGORIES = frozenset({"permissions", "money", "policy", "safety"})
CATEGORIES = HQ_CATEGORIES | {"method", "tooling", "communication", "quality", "domain"}

_ASCII = (
    "permission permissions privilege privileges access admin administrator role roles approve approved approval approver "
    "authorize authorise authorization authorisation token tokens password passwords secret secrets credential credentials "
    "budget spend spending price pricing cost costs payment payments pay paid invoice refund discount salary money baht thb "
    "usd fund funds transfer policy policies rule rules regulation compliance legal contract law safety override bypass "
    "ignore disregard jailbreak instruction instructions escalate escalation hire fire delete destroy deploy production "
    "root sudo pii private confidential email phone address share forward publish upload external webhook link url "
    # Gate 2 re-check: irregular forms and prefixed compounds the suffix rule cannot reach
    "overridden overrode spent salaries monies transferred transferring instruct unauthorize unauthorise unapprove "
    "preapprove superadmin sysadmin"
).split() + ["api key", "apikey", "system prompt", "skip review", "customer data", "personal data", "password reset"]
_SYMBOLS = ("$", "฿")
_THAI = (
    "สิทธิ อนุมัติ แอดมิน ผู้ดูแลระบบ รหัสผ่าน โทเคน โทเค็น ความลับ งบประมาณ ค่าใช้จ่าย ราคา เงิน บาท จ่าย ชำระ โอน ใบแจ้งหนี้ "
    "คืนเงิน ส่วนลด นโยบาย กฎ ระเบียบ ข้อบังคับ กฎหมาย สัญญา ความปลอดภัย ข้ามขั้นตอน ยกเว้น เพิกเฉย ไม่ต้องขอ คำสั่งระบบ จ้าง "
    "ไล่ออก ลบ ข้อมูลลูกค้า ข้อมูลส่วนตัว เบอร์โทร อีเมล ที่อยู่ ส่งต่อ เผยแพร่ ภายนอก ลิงก์"
).split()
# G2T033-02: also match inflections (admins, approving, deleted, escalated...); a final "e" may drop before the suffix.
_SUFFIX = r"(?:s|es|d|ed|ing|er|ers|ion|ions|ment|ments)?"
_KW = re.compile(r"(?<![a-z0-9])((?:" + "|".join(
    re.escape(k[:-1]) + "e?" if k.endswith("e") and " " not in k else re.escape(k)
    for k in sorted(_ASCII, key=len, reverse=True)) + r")" + _SUFFIX + r")(?![a-z0-9])")
_ODD = re.compile(r"[^\x20-\x7eก-๛]")
_STRIP = {"Cc", "Cf", "Co", "Cs", "Zl", "Zp"}
_BAD_CONTENT = ("<", ">", "＜", "＞", "﹤", "﹥", "http://", "https://", "www.", "discord.gg", "@everyone", "@here")
_DIGITS = re.compile(r"\d{15,}")  # any Unicode decimal digit: Thai ๐-๙ bypassed [0-9] (Gate 2 G2T033-01)


def clean(text: str) -> str:
    """G033-02: whitespace to one space, then drop Cc/Cf/Co/Cs/Zl/Zp, variation selectors and U+180E; NFC."""
    t = " ".join(text.split())
    t = "".join(c for c in t if unicodedata.category(c) not in _STRIP and not 0xFE00 <= ord(c) <= 0xFE0F and c != "᠎")
    return unicodedata.normalize("NFC", t)


def content_bad(text: str) -> bool:
    """G033-03: markup, links, mentions or long digit runs are refused outright."""
    for t in (text.casefold(), clean(unicodedata.normalize("NFKC", text)).casefold()):
        if any(b in t for b in _BAD_CONTENT) or _DIGITS.search(t):
            return True
    return False


def hq_reason(category: str, text: str) -> str | None:
    """First HQ-forcing reason ("category:<c>" | "keyword:<kw>"), or None for a plain work-method lesson."""
    if category not in CATEGORIES or category in HQ_CATEGORIES:
        return f"category:{category}"[:64]
    t = normalise(clean(unicodedata.normalize("NFKC", clean(text))))
    if _ODD.search(t):
        return "keyword:charset"
    m = _KW.search(t)
    if m:
        return f"keyword:{m.group(1)}"
    return next((f"keyword:{k}" for k in (*_SYMBOLS, *_THAI) if k in t), None)
