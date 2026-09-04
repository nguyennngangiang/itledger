"""What kind of file did the user just drop on the importer?

The Import button opens one drop zone, so something has to decide whether a file is
a handover record, a device list or a repair-history sheet. Two tiers, in this order:

1. **Keyword / header heuristics, in plain code.** Instant, offline, no LLM tokens,
   and the answer is explainable ("thấy tiêu đề BIÊN BẢN BÀN GIAO"). This settles
   the everyday cases, which all come off the same few company templates.
2. **The LLM**, only when the heuristics find nothing or find two things at once.

The result is always shown to the user with a "đổi loại" escape hatch, so a wrong
guess costs one click — that is why a heuristic is allowed to be confident here.

The alias sets below are for DETECTION ONLY: enough to recognise a header row, not
to map it. Column→field mapping lives in the frontend import modals, which own the
full alias tables.
"""
import json

import httpx

from .handover_import import fold

HANDOVER = "handover_minutes"
DEVICES = "device_list"
MAINTENANCE = "maintenance_list"
UNKNOWN = "unknown"
KINDS = frozenset({HANDOVER, DEVICES, MAINTENANCE})

# Phrases that only appear on a handover record. The bilingual title and the
# party labels are printed on the company template, so any real record has them.
_HANDOVER_MARKERS = (
    "bien ban ban giao",
    "handover minutes",
    "ma nv/ code",
    "party a",
    "noi dung ban giao",
)

# Header words. A list is recognised by having a device column PLUS at least one
# column that only that kind of sheet carries.
_SERIAL_WORDS = ("serial", "serial number", "sn", "so serial", "barcode")
_DEVICE_WORDS = ("brand", "hang", "cpu", "ram", "storage", "o cung", "msoffice",
                 "buy date", "purchase date", "ngay mua", "device name", "ten may")
_MAINTENANCE_WORDS = ("part", "hang muc", "solution", "cach xu ly", "result",
                      "ket qua", "cost", "chi phi", "repair", "sua chua",
                      "maintenance date", "ngay sua")


def _hits(text: str, words: tuple[str, ...]) -> list[str]:
    return [w for w in words if w in text]


# Header words are matched against the TOP of the file only. Searching the whole
# text reads data as headers: a repair sheet whose "Hạng mục" column contains the
# value "RAM" looked exactly like a device sheet with a RAM column, so every repair
# sheet came out ambiguous. Headers live in the first rows; values do not.
_HEADER_LINES = 8


def _header_region(source_text: str) -> str:
    lines = [ln for ln in (source_text or "").splitlines() if ln.strip()]
    return fold("\n".join(lines[:_HEADER_LINES]))


def detect_kind(source_text: str) -> dict:
    """Heuristic pass. Returns {kind, reason, confident}.

    `confident` is False when nothing matched or when the two table kinds matched
    equally — those are the only cases worth spending an LLM call on.
    """
    handover_hits = _hits(fold(source_text), _HANDOVER_MARKERS)
    if handover_hits:
        # A handover record is a form, not a table, and its markers are printed
        # prose ("Bên A / Party A") that no table ever carries — so this one is
        # matched across the whole text and decided outright.
        return {
            "kind": HANDOVER,
            "reason": f'Thấy dấu hiệu của biên bản bàn giao: "{handover_hits[0]}".',
            "confident": True,
        }

    header = _header_region(source_text)
    serial = _hits(header, _SERIAL_WORDS)
    device_hits = _hits(header, _DEVICE_WORDS)
    maint_hits = _hits(header, _MAINTENANCE_WORDS)

    if len(maint_hits) > len(device_hits):
        return {
            "kind": MAINTENANCE,
            "reason": f'Thấy cột đặc trưng của lịch sử sửa chữa: {", ".join(maint_hits[:3])}.',
            "confident": bool(serial),
        }
    if len(device_hits) > len(maint_hits):
        return {
            "kind": DEVICES,
            "reason": f'Thấy cột đặc trưng của danh sách thiết bị: {", ".join(device_hits[:3])}.',
            "confident": bool(serial),
        }
    if device_hits:  # a genuine tie — don't guess
        return {
            "kind": UNKNOWN,
            "reason": "Header có cả cột thiết bị và cột sửa chữa — chưa rõ là loại nào.",
            "confident": False,
        }
    return {
        "kind": UNKNOWN,
        "reason": "Không thấy tiêu đề hay cột nào nhận ra được.",
        "confident": False,
    }


_LLM_SYSTEM = """\
You classify ONE uploaded file, already converted to text, into exactly one kind:

- "handover_minutes" — a handover record (BIÊN BẢN BÀN GIAO / HANDOVER MINUTES): a
  form naming two parties and listing the item(s) changing hands.
- "device_list" — a table of company machines: serial numbers with specs
  (brand, CPU, RAM, storage, OS, purchase date, owner).
- "maintenance_list" — a table of repairs: a device plus what was fixed, why, the
  result and often a cost.
- "unknown" — none of the above, or genuinely unclear.

Answer ONLY as JSON: {"kind":"<one of the four>","reason":"<one short sentence in
Vietnamese>"}. Prefer "unknown" over a guess: a wrong kind sends the user's data
down the wrong importer."""


async def detect_kind_with_llm(source_text: str, chat) -> dict:
    """Second tier. `chat` is llm._chat, injected so this module doesn't import the
    LLM client (and so tests can pass a stub). Returns {kind, reason, confident}.

    Falls back to unknown on any failure — the drop zone then just asks the user to
    pick, which is a fine outcome and never blocks the import.
    """
    # Only the head matters for classifying, and it keeps the prompt small.
    excerpt = (source_text or "")[:4000]
    try:
        raw = await chat(
            _LLM_SYSTEM,
            f"File content:\n{excerpt}",
            want_json=True,
            temperature=0.0,
            timeout=120,
        )
        parsed = json.loads(raw)
    except (httpx.HTTPError, json.JSONDecodeError, KeyError, TypeError):
        return {"kind": UNKNOWN, "reason": "AI không phân loại được file này.",
                "confident": False}
    kind = parsed.get("kind") if isinstance(parsed, dict) else None
    if kind not in KINDS:
        return {"kind": UNKNOWN,
                "reason": str((parsed or {}).get("reason") or "Chưa rõ loại file."),
                "confident": False}
    return {
        "kind": kind,
        "reason": str(parsed.get("reason") or "AI nhận dạng."),
        "confident": True,
    }
