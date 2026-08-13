"""Handover-minutes import: verify what the LLM read, and the rules around it.

**Verification.** `verify_parsed()` checks every string the model returned against
the source text it was given. The model's job is to locate fields in a bilingual
form and split a spec sentence — not to produce values. Anything that isn't
actually in the file is dropped with a warning, so a hallucinated serial can never
reach the database.

A record is **N parties and M movements**, not a pair and a list: `parties` is
whatever `Bên A / Bên B / Bên C …` blocks the form actually carries, and each item
gets a `row` — its position — because a record may move the same device twice and
the serial is then not an identity.

**Direction** lives next door in `be/handover_direction.py`, as a chain of
resolvers over one movement at a time. It is ordered plain code rather than a
model's judgement call because getting it wrong corrupts ownership.

What is left here besides verification is the shared vocabulary that both the
importer and the handover *form* read: the flow constants, `status_after`, and the
`looks_like_return` / `store_recipient` pair.
"""
import unicodedata
from datetime import date

# be.constants imports nothing, so this module stays database-free — which is
# what lets most of its tests be plain synchronous unit tests.
from .constants import GHOST_CODE, IT_HELD_STATUSES

RETURN = "return"    # người dùng trả máy về IT
ISSUE = "issue"      # IT bàn giao máy cho người dùng
TRANSFER = "transfer"  # người dùng ↔ người dùng, không có bên IT
FLOWS = frozenset({RETURN, ISSUE, TRANSFER})


def fold(value: object) -> str:
    """Lowercase + strip Vietnamese diacritics, for comparing text to the source.

    Mirrors what unaccent() does in SQL so "Bui Thi Thanh" matches "Bùi Thị Thanh".
    `đ` has no NFD decomposition, so it needs the explicit map; casefold has
    already turned any `Đ` into `đ` by then.
    """
    if value is None:
        return ""
    text = unicodedata.normalize("NFD", str(value)).casefold()
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.replace("đ", "d")


# ---------------------------------------------------------------- verification

# Fields on a party / item that must appear verbatim in the source text.
_PARTY_FIELDS = ("name", "code", "dept", "position")
# Fallback labels when the form's own `Bên X` letter didn't survive the read.
_PARTY_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ITEM_TEXT_FIELDS = ("item", "detail", "serial", "note")
_DEVICE_FIELDS = ("type", "brand", "cpu", "ram", "storage", "name")


def _clean(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _keep_if_present(
    value: object, folded_source: str, label: str, warnings: list[str]
) -> str | None:
    """Return the value only if it really occurs in the source text."""
    text = _clean(value)
    if text is None:
        return None
    if fold(text) in folded_source:
        return text
    warnings.append(f"Bỏ qua {label}: \"{text}\" không có trong file.")
    return None


def _verify_party(party: object, folded_source: str, label: str, warnings: list[str]) -> dict:
    party = party if isinstance(party, dict) else {}
    return {
        f: _keep_if_present(party.get(f), folded_source, f"{label} · {f}", warnings)
        for f in _PARTY_FIELDS
    }


def _verify_parties(raw: object, folded_source: str, warnings: list[str]) -> list[dict]:
    """Every `Bên X/ Party X` block the form carries — two, three or more.

    A party whose every field fails verification is dropped rather than kept as a
    row of nulls: a model asked for a list will occasionally pad one, and an empty
    party would otherwise reach the review screen as a card with nothing on it.

    The label is not checked against the source. It is a single letter, so it
    "appears in the file" no matter what, and verifying it would mean nothing;
    when the model omits it, position supplies it.
    """
    parties: list[dict] = []
    for index, party in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(party, dict):
            continue
        label = _clean(party.get("label")) or _PARTY_LABELS[index % len(_PARTY_LABELS)]
        verified = _verify_party(party, folded_source, f"Bên {label}", warnings)
        if not any(verified.values()):
            warnings.append(f"Bỏ qua Bên {label}: không có thông tin nào có trong file.")
            continue
        parties.append({"label": label, **verified})
    if len(parties) < 2:
        warnings.append(
            f"Chỉ đọc được {len(parties)} bên trong biên bản — cần ít nhất hai bên."
        )
    return parties


def _verify_date(value: object, folded_source: str, warnings: list[str]) -> str | None:
    """The flattened sheet carries `[YYYY-MM-DD]` after every date cell, so a real
    date is verifiable the same way as any other value."""
    text = _clean(value)
    if text is None:
        warnings.append("Không đọc được ngày bàn giao.")
        return None
    try:
        iso = date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        warnings.append(f'Ngày "{text}" không đúng định dạng — bỏ qua.')
        return None
    if iso not in folded_source:
        warnings.append(
            f'Ngày "{iso}" không khớp ô ngày nào trong file — kiểm tra lại.'
        )
        return None
    return iso


def _verify_int(value: object, default: int | None = None) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def verify_parsed(parsed: dict, source_text: str) -> tuple[dict, list[str]]:
    """Keep only what the source text actually contains. Returns (parsed, warnings).

    An item with no verifiable serial is dropped entirely: without a serial there
    is no device to attach the handover to, and guessing one would be worse than
    reporting the gap.
    """
    warnings: list[str] = []
    folded = fold(source_text)
    parsed = parsed if isinstance(parsed, dict) else {}

    out: dict = {
        "handover_date": _verify_date(parsed.get("handover_date"), folded, warnings),
        "place": _keep_if_present(parsed.get("place"), folded, "địa điểm", warnings),
        "parties": _verify_parties(parsed.get("parties"), folded, warnings),
        "items": [],
    }

    raw_items = parsed.get("items")
    if not isinstance(raw_items, list):
        raw_items = []
    for index, raw in enumerate(raw_items, start=1):
        if not isinstance(raw, dict):
            continue
        label = f"dòng {raw.get('no') or index}"
        item = {
            f: _keep_if_present(raw.get(f), folded, f"{label} · {f}", warnings)
            for f in _ITEM_TEXT_FIELDS
        }
        if not item["serial"]:
            warnings.append(f"Bỏ qua {label}: không có SERIAL đọc được.")
            continue
        raw_device = raw.get("device") if isinstance(raw.get("device"), dict) else {}
        # `no` is the form's own numbering, for display. `row` is the movement's
        # identity, and is positional precisely so that it is always unique: one
        # record can move the same device twice (A→B, then B→C), and keying those
        # two movements on the serial merges them into one.
        item["row"] = len(out["items"]) + 1
        item["no"] = _verify_int(raw.get("no"), index)
        item["quantity"] = _verify_int(raw.get("quantity"), 1)
        item["device"] = {
            f: _keep_if_present(
                raw_device.get(f), folded, f"{label} · device.{f}", warnings
            )
            for f in _DEVICE_FIELDS
        }
        out["items"].append(item)

    if not out["items"]:
        warnings.append("Không có dòng thiết bị nào đọc được từ file này.")
    return out, warnings


# ------------------------------------------------------------------- IT side

def _looks_it(*values: object) -> bool:
    """Is any of these values the IT department / an IT job title?

    Token match, so "UNIT" or "AUDIT" don't count, but "IT", "IT Staff" and
    "IT Support" all do.
    """
    for value in values:
        tokens = fold(value).replace("/", " ").replace("-", " ").split()
        if "it" in tokens:
            return True
    return False


# Reasons that mean the machine is coming back, WHEN it lands on IT.
#
# Never read without checking the recipient. "Replacement" runs in both directions
# in this ledger — VPHN102 → VPHN228 is an old machine coming back, VPHN229 →
# VPHN301 is a new one going out — so the reason alone decides nothing. That check
# is what `store_recipient` exists for, and the handover form applies the same pair
# (it reads the recipient's team, so it can use this whole list).
RETURN_WHEN_TO_IT = (
    "return to it", "return to the it", "returned to it", "it store",
    "resignation return", "recall",
    "tra ve kho", "tra ve it", "thu hoi", "hoan tra",
    "replacement", "resignation", "nghi viec",
)


def looks_like_return(reason: object) -> bool:
    """Does this handover reason mean the device is going BACK to IT?

    The single source of truth for the rule, because the ledger's own data shows
    what happens without one: the frontend carried its own copy that only knew
    "return to it" / "trả về kho" / "thu hồi", so rows reading "Resignation
    Return" and "Replacement" were treated as ordinary hand-outs and left the
    machine standing in an IT staffer's name. One person ended up holding 29
    devices when the team issues each of its members exactly one laptop.

    Only ever consulted together with the recipient, via `store_recipient` — on
    its own it would send an outgoing "Replacement" to the store.
    """
    folded = fold(reason)
    return any(phrase in folded for phrase in RETURN_WHEN_TO_IT)


def is_it_own_machine(device: dict | None) -> bool:
    """The laptop IT issues to its own members: an Asus Core i7 Ultra 32GB.

    Everything else standing in an IT staffer's name is stock. Without this
    exception the rule below would sweep the team's own three laptops into the
    store the moment they were logged as a "Replacement".
    """
    text = fold((device or {}).get("name")) + " " + fold((device or {}).get("cpu"))
    return "asus" in text and "i7 ultra" in text


def store_recipient(
    reason: object,
    to_user_id: str | None,
    to_user: dict | None,
    device: dict | None = None,
) -> str | None:
    """Who should actually receive this handover.

    A machine handed back "to IT" goes to the department, not to the individual
    who signed for it — IT staff hold one machine each, and anything else in
    their name is unfiled stock.

    All three inputs matter. The reason alone is not enough: "Replacement" runs
    in BOTH directions in this ledger — VPHN102 → VPHN228 is an old machine
    coming back, while VPHN229 → VPHN301 is a replacement going out — so the
    recipient has to be IT for it to count. And the device matters too, because
    the day IT replaced its own three laptops those rows read "Replacement" to an
    IT person as well; `is_it_own_machine` keeps those where they belong.
    """
    if not to_user_id or to_user_id == GHOST_CODE:
        return to_user_id
    if not (to_user and _looks_it(to_user.get("team"))):
        return to_user_id
    if not looks_like_return(reason):
        return to_user_id
    if is_it_own_machine(device):
        return to_user_id
    return GHOST_CODE


def detect_it_side(
    parties: list[dict], users: list[dict | None]
) -> tuple[int | None, str]:
    """Which party is the IT side. Returns (index into `parties`, reason).

    Reads the minutes' own Chức vụ / Bộ phận first, then the ledger's stored team.
    Both are needed: VPHN228's minutes say dept Operation / position IT, while the
    ledger has team "IT" — either alone would be enough here, but neither is always
    filled in.

    The minutes' Chức vụ still counts; the users table no longer stores one. That
    column held a title for two people out of 235 and split the signal in two —
    VPHN228 read team "Operation" / position "IT", so the team lookup scored him
    zero. His team now says IT, which is what every other rule reads too.

    There is at most one IT side however many parties sign: a clear winner needs a
    strictly highest score, so two IT-looking parties settle nothing and say so.
    """
    def score(party: dict, user: dict | None) -> int:
        points = 0
        if _looks_it(party.get("position")):
            points += 2
        if _looks_it(party.get("dept")):
            points += 2
        if user and _looks_it(user.get("team")):
            points += 2
        return points

    scores = [
        score(party, user)
        for party, user in zip(parties, list(users) + [None] * len(parties))
    ]
    if not scores or max(scores) == 0:
        return None, "Không bên nào là IT — coi là chuyển máy giữa hai người dùng."
    best = max(scores)
    if scores.count(best) > 1:
        return None, "Có nhiều bên trông như IT — không tự quyết được."
    index = scores.index(best)
    party = parties[index]
    return index, _it_reason(
        party.get("label") or _PARTY_LABELS[index % len(_PARTY_LABELS)],
        party,
        list(users)[index] if index < len(users) else None,
    )


def _it_reason(label: str, party: dict, user: dict | None) -> str:
    bits = []
    if _looks_it(party.get("position")):
        bits.append(f'chức vụ "{party.get("position")}"')
    if _looks_it(party.get("dept")):
        bits.append(f'bộ phận "{party.get("dept")}"')
    if user and _looks_it(user.get("team")):
        bits.append(f'team "{user.get("team")}" trong hệ thống')
    return f"Bên {label} là bên IT ({', '.join(bits)})."


# --------------------------------------------------------- derived from a move

def status_after(owner: str | None, current_status: str | None) -> str:
    """Same rule as deriveStatus in fe/src/lib/format.ts.

    Public because be/handover_direction.py derives it for every movement it
    resolves; the two must not drift apart.
    """
    if owner and owner != GHOST_CODE:
        return "active"
    return current_status if current_status in IT_HELD_STATUSES else "in_stock"


def apply_flow(flow: str, *, user_code: str | None, it_code: str | None,
               device: dict | None) -> dict:
    """The from/to/owner/status a bare flow implies, for a two-party record.

    `apply` prefers the movement's own `from_user_id` / `to_user_id`, which is the
    only thing that can describe a record with three parties. This stays for the
    two-party case, where naming a flow does still pin the pair down, so a caller
    that sends `{"flow": "return"}` and nothing else is still understood.
    """
    if flow == RETURN:
        return {
            "from_user_id": user_code,
            "to_user_id": it_code,
            "device_owner_after": GHOST_CODE,
            "device_status_after": status_after(
                GHOST_CODE, (device or {}).get("status")
            ),
        }
    return {
        "from_user_id": it_code,
        "to_user_id": user_code,
        "device_owner_after": user_code,
        "device_status_after": status_after(
            user_code, (device or {}).get("status")
        ),
    }
