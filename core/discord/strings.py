"""Fixed user-facing strings for the Discord layer (spec 3.3, 5.5). No free text from users or models."""
PLACEHOLDER = "..."
TRUNCATED = "[output truncated]"
BUTTON_INACTIVE = "This button is no longer active. / ปุ่มนี้ใช้งานไม่ได้แล้ว"
NOT_ALLOWED = "This bot is not available in this channel. / บอทไม่ได้เปิดใช้ในช่องนี้"
INTERNAL_ERROR = "Something went wrong. / เกิดข้อผิดพลาด"
VOICE_NOT_AVAILABLE = "voice_not_available"
APPROVED = "Approved. / อนุมัติแล้ว"
REJECTED = "Rejected. / ปฏิเสธแล้ว"
NOT_APPROVER = "not_approver: only the approver role can decide. / เฉพาะผู้อนุมัติเท่านั้น"
EXPIRED = "expired: this request has expired. / คำขอหมดอายุแล้ว"
ALREADY_DECIDED = "already_decided / ตัดสินแล้ว"

# -- voice (spec 12.12.14): every code is an ephemeral reply "<code>: english / ไทย". Fixed text only.
_V = {
    "voice_disabled": ("voice is disabled", "ระบบเสียงถูกปิดอยู่"),
    "live_capture_disabled": ("live transcription is off", "การถอดเสียงสดปิดอยู่"),
    "paid_tier_not_confirmed": ("the owner has not confirmed the paid Gemini tier, so nothing is recorded", "เจ้าของยังไม่ยืนยันแพ็กเกจ Gemini แบบเสียเงิน จึงไม่บันทึก"),
    "opus_not_loaded": ("the voice library (libopus) is missing", "ไม่พบไลบรารีเสียง (libopus)"),
    "not_in_voice": ("join a voice channel first", "ต้องอยู่ในช่องเสียงก่อน"),
    "target_not_allowed": ("this voice channel is not enabled for the bot", "ช่องเสียงนี้ไม่ได้เปิดใช้กับบอท"),
    "voice_busy": ("a voice session is already active", "มีเซสชันเสียงที่ทำงานอยู่แล้ว"),
    "consent_gap": ("recording stays off until the owner confirms consent", "ยังไม่บันทึกจนกว่าเจ้าของจะยืนยันความยินยอม"),
    "notice_failed": ("could not post the recording notice, so nothing is recorded", "โพสต์ประกาศการบันทึกไม่สำเร็จ จึงไม่บันทึก"),
    "budget_exhausted": ("today's budget is used up", "งบวันนี้หมดแล้ว"),
    "not_allowed": ("only someone in that voice channel or an approver can do this", "ทำได้เฉพาะผู้อยู่ในช่องเสียงนั้นหรือผู้อนุมัติ"),
    "no_session": ("no active voice session", "ไม่มีเซสชันเสียงที่ทำงานอยู่"),
    "receive_failed": ("live transcription unavailable", "ถอดเสียงสดไม่พร้อมใช้งาน"),
    "ok_join": ("joined the voice channel (speech replies only, no recording)", "เข้าช่องเสียงแล้ว (พูดตอบอย่างเดียว ไม่บันทึก)"),
    "ok_leave": ("left the voice channel", "ออกจากช่องเสียงแล้ว"),
    "ok_record_start": ("notice posted; recording starts after the delay", "โพสต์ประกาศแล้ว จะเริ่มบันทึกหลังหน่วงเวลา"),
    "ok_record_stop": ("stopping, the note will be posted", "กำลังหยุดและสรุปบันทึก"),
    "ok_optout": ("you are opted out of voice recording", "ยกเลิกการบันทึกเสียงของคุณแล้ว"),
    "ok_optin": ("you are opted in to voice recording", "อนุญาตการบันทึกเสียงของคุณแล้ว"),
}
LIVE_UNAVAILABLE = "live transcription unavailable / ถอดเสียงสดไม่พร้อมใช้งาน"
NO_SPEECH = "done: no speech captured. / เสร็จแล้ว: ไม่มีเสียงพูดที่บันทึกได้"


def voice_reply(code: str) -> str:
    en, th = _V.get(code, ("something went wrong", "เกิดข้อผิดพลาด"))
    return f"{code}: {en} / {th}"


def voice_notice_text(provider: str, retention_days: int = 90) -> str:
    """S1212-05/13, 12.12.23: our copy vs Google's retention. provider: gemini | google-stt."""
    if provider == "google-stt":
        svc_en = "Google Cloud Speech-to-Text and is handled under Google Cloud terms"
        svc_th = "Google Cloud Speech-to-Text และอยู่ภายใต้เงื่อนไขของ Google Cloud"
        g_en = "Google may keep it for a limited time under those terms."
        g_th = "Google อาจเก็บไว้ชั่วคราวตามเงื่อนไขดังกล่าว"
    else:
        svc_en = "Google (Gemini API, paid tier)"
        svc_th = "Google (Gemini API แบบเสียเงิน)"
        g_en = ("Under Google's paid API terms it is not used to train Google's models; "
                "Google may keep it for a limited time only to detect abuse.")
        g_th = ("ตามเงื่อนไข API แบบเสียเงินของ Google จะไม่ถูกใช้ฝึกโมเดลของ Google "
                "แต่ Google อาจเก็บไว้ชั่วคราวเพื่อตรวจจับการใช้งานที่ไม่เหมาะสมเท่านั้น")
    return (f"This voice channel is being transcribed. We keep audio only in memory and delete our copy right after each "
            f"~30-second piece is transcribed. The audio is sent to {svc_en} for transcription and processed outside Thailand "
            f"at a location Google chooses. {g_en} "
            f"The meeting note is visible only to the members who spoke and approvers, and kept {retention_days} days. "
            f"Use Opt out or /voice optout to be excluded; an approver can erase a note.\n"
            f"ช่องเสียงนี้กำลังถอดเสียง เราเก็บเสียงในหน่วยความจำเท่านั้น และลบสำเนาของเราทันทีหลังถอดเสียงแต่ละช่วง ~30 วินาที "
            f"เสียงจะถูกส่งไปยัง {svc_th} เพื่อถอดเสียง และประมวลผลนอกประเทศไทยในตำแหน่งที่ Google เลือก "
            f"{g_th} "
            f"บันทึกการประชุมเห็นได้เฉพาะผู้ที่พูดและผู้อนุมัติ เก็บ {retention_days} วัน "
            f"กด Opt out หรือ /voice optout เพื่อไม่ถูกบันทึก ผู้อนุมัติลบบันทึกได้")


REASK_TEXT = ("Earlier opt-out choices may have been lost in a restore. If you want to opt out, please do so again now. "
              "Recording stays off until the owner confirms consent.\n"
              "ตัวเลือก opt-out ก่อนหน้าอาจหายไปจากการกู้คืนข้อมูล หากต้องการไม่ถูกบันทึก กรุณากด opt-out อีกครั้ง "
              "จะไม่บันทึกจนกว่าเจ้าของยืนยันความยินยอม")
