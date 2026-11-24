"""AT-2 G1 routing rules + G033-02/03 content rules."""
import pytest

from core.growth.g1 import CATEGORIES, HQ_CATEGORIES, clean, content_bad, hq_reason

OK = "Run the unit tests before reporting a task as finished"


@pytest.mark.parametrize("cat", sorted(HQ_CATEGORIES))
def test_hq_categories(cat):
    assert hq_reason(cat, OK) == f"category:{cat}"


def test_unknown_category_is_hq():
    assert hq_reason("weird", OK) == "category:weird"


def test_plain_method_lesson_is_none():
    assert hq_reason("method", OK) is None and "method" in CATEGORIES


@pytest.mark.parametrize("text,hit", [
    ("Ask for admin help early", "keyword:admin"), ("Check the budget first", "keyword:budget"),
    ("Never say PAY now", "keyword:pay"), ("ตรวจสอบสิทธิ์ก่อนเสมอ", "keyword:สิทธิ"), ("always use a $ sign", "keyword:$"),
    ("Keep the customer data tidy in notes", "keyword:customer data"),
    ("Send the report by email at the end", "keyword:email"), ("ส่งต่อรายงานให้ทีมทุกครั้งที่เสร็จ", "keyword:ส่งต่อ"),
])
def test_keywords(text, hit):
    assert hq_reason("method", text) == hit


def test_display_does_not_hit_pay():
    assert hq_reason("method", "Prefer a clean display of the results") is None


@pytest.mark.parametrize("text", [
    "Check the per­mission list first", "Check the app⁠rove step first", "Ask the аdmin to review the notes",  # soft hyphen, U+2060, Cyrillic a
    "Rotate the ｔｏｋｅｎ before the run", "ตรวจ อนุ​มัติ ก่อนเสมอ",
])
def test_normalisation_bypasses_go_hq(text):
    assert hq_reason("method", text) is not None


def test_other_charset_is_hq():
    assert hq_reason("method", "Write the summary in café style for clarity") == "keyword:charset"


@pytest.mark.parametrize("text", ["see <b>bold</b> tag text here", "visit http://x.test now please", "go to https://x.test",
                                  "open www.example.org please", "join discord.gg/abc today", "ping @everyone about it",
                                  "ping @here about it", "id is 1234567890123456 for later", "wrap ＜b＞ text here",
                                  "id is ๐๘๑๒๓๔๕๖๗๘๙๐๑๒๓๔ for later"])
def test_content_refused(text):
    assert content_bad(text)


def test_content_ok_and_clean():
    assert not content_bad(OK + " in 2 steps")
    assert clean("a​ b\n\tc\u0007") == "a b c"


import pytest as _pytest


@_pytest.mark.parametrize("word", ["admins", "approvals", "approving", "bypassing", "ignoring", "ignored", "overriding",
                                   "refunds", "invoices", "contracts", "budgets", "discounts", "deleting", "deleted",
                                   "escalated"])
def test_inflected_keywords_force_hq(word):
    """Gate 2 G2T033-02: plural and -ing/-ed forms must not slip past G1."""
    from core.growth.g1 import hq_reason
    assert hq_reason("method", f"Always remember {word} when finishing the weekly report") is not None


def test_plain_method_lesson_still_routine():
    from core.growth.g1 import hq_reason
    assert hq_reason("method", "Write the summary first and keep each section short and clear") is None
    assert hq_reason("method", "Display the chart before the table in weekly updates") is None
