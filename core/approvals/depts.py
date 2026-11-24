"""Department codes, heads and channel seeds. Fixed in code (spec R2, OQ-4)."""
DEPT_CODES = {"account": "FIN", "hr": "HR", "marketing": "MKT", "sales": "SAL", "operations": "OPS", "it": "IT",
              "legal": "LEG", "procurement": "PRC", "support": "SUP", "data": "DAT", "design": "DSN",
              "product": "PRD", "dev": "DEV", "exec": "HQ", "praw": "HQ"}
HQ_ONLY = {"exec", "praw"}  # never a head, never dept-level (D1: Mira never decides)
DEFAULT_HEADS = {"account": "mali", "hr": "fahsai", "marketing": "somo", "sales": "bass", "operations": "ploy",
                 "it": "phupha", "legal": "thara", "procurement": "pat", "support": "sai", "data": "kawin",
                 "design": "nicha", "product": "pim", "dev": "tek"}
# OQ-4 seeds for approval.channel.<code>; every other department defaults to hq
CHANNEL_SEEDS = {"account": 1567005451516772513, "hr": 1567005110243033228, "marketing": 1567005741003313212,
                 "sales": 1567005947287568474, "operations": 1567006095526858884, "product": 1567005024146554960,
                 "dev": 1567004690351128676}


def code_of(slug: str) -> str:
    return DEPT_CODES.get(slug, "HQ")


def slug_of(code: str) -> str | None:
    """Department slug for a code (HQ has none: it is never a head's department)."""
    return next((s for s, c in DEPT_CODES.items() if c == code and s not in HQ_ONLY), None)


# dept slugs that can carry settings (excludes HQ_ONLY)
# a list so register_dept can extend it in place (TASK-033 R21)
DEPT_SLUGS = [s for s in DEPT_CODES if s not in HQ_ONLY]
