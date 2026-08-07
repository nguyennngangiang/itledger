"""Handover-minutes import logic: verify what the LLM read, then decide direction.

Two jobs, both deliberately kept out of the LLM's hands:

**Verification.** `verify_parsed()` checks every string the model returned against
the source text it was given. The model's job is to locate fields in a bilingual
form and split a spec sentence — not to produce values. Anything that isn't
actually in the file is dropped with a warning, so a hallucinated serial can never
reach the database.

**Direction.** `decide_flow()` works out, per line item, whether the machine is
going out to a person or coming back to IT. The minutes cannot tell us: Bên A /
Bên B are just "the two parties", and one record routinely mixes both directions
(row 1 the old machine coming back, row 2 the new one going out) — while plenty of
records only hand one machine out and have no return row at all. So each row is
classified independently, from the ledger's own history, and the UI shows the
reason and lets a human flip it.

Getting direction wrong corrupts ownership, which is why it is ordered plain code
here rather than a model's judgement call.
"""
import unicodedata
from datetime import date

GHOST_CODE = "IT-STORE"

# Statuses that mean IT is physically holding the machine — a handover must not
# clear them (mirrors deriveStatus in fe/src/lib/format.ts).
IT_HELD_STATUSES = frozenset({"maintaining", "on_del"})

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
        "party_a": _verify_party(parsed.get("party_a"), folded, "Bên A", warnings),
        "party_b": _verify_party(parsed.get("party_b"), folded, "Bên B", warnings),
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
    party_a: dict, party_b: dict, user_a: dict | None, user_b: dict | None
) -> tuple[str | None, str]:
    """Which party is the IT side: "a", "b", or None. Returns (side, reason).

    Reads the minutes' own Chức vụ / Bộ phận first, then the ledger's stored team.
    Both are needed: VPHN228's minutes say dept Operation / position IT, while the
    ledger has team "IT" — either alone would be enough here, but neither is always
    filled in.

    The minutes' Chức vụ still counts; the users table no longer stores one. That
    column held a title for two people out of 235 and split the signal in two —
    VPHN228 read team "Operation" / position "IT", so the team lookup scored him
    zero. His team now says IT, which is what every other rule reads too.
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

    a, b = score(party_a, user_a), score(party_b, user_b)
    if a > b:
        return "a", _it_reason("A", party_a, user_a)
    if b > a:
        return "b", _it_reason("B", party_b, user_b)
    if a == 0:
        return None, "Không bên nào là IT — coi là chuyển máy giữa hai người dùng."
    return None, "Cả hai bên đều trông như IT — không tự quyết được."


def _it_reason(label: str, party: dict, user: dict | None) -> str:
    bits = []
    if _looks_it(party.get("position")):
        bits.append(f'chức vụ "{party.get("position")}"')
    if _looks_it(party.get("dept")):
        bits.append(f'bộ phận "{party.get("dept")}"')
    if user and _looks_it(user.get("team")):
        bits.append(f'team "{user.get("team")}" trong hệ thống')
    return f"Bên {label} là bên IT ({', '.join(bits)})."


# ----------------------------------------------------------------- direction

class FlowDecision(dict):
    """A per-item direction decision. A dict so it serialises straight to JSON."""


def _status_after(owner: str | None, current_status: str | None) -> str:
    """Same rule as deriveStatus in fe/src/lib/format.ts."""
    if owner and owner != GHOST_CODE:
        return "active"
    return current_status if current_status in IT_HELD_STATUSES else "in_stock"


def _decision(
    flow: str,
    from_user: str | None,
    to_user: str | None,
    owner_after: str | None,
    device: dict | None,
    reason: str,
    *,
    ambiguous: bool = False,
    duplicate_of: dict | None = None,
) -> FlowDecision:
    return FlowDecision(
        flow=flow,
        from_user_id=from_user,
        to_user_id=to_user,
        device_owner_after=owner_after,
        device_status_after=_status_after(
            owner_after, (device or {}).get("status")
        ),
        flow_reason=reason,
        ambiguous=ambiguous,
        duplicate_of=duplicate_of,
    )


def decide_flow(
    *,
    user_code: str | None,
    it_code: str | None,
    other_code: str | None = None,
    device: dict | None,
    history: list[dict],
) -> FlowDecision:
    """Classify one line item. Rules are tried in order; the first that fits wins.

    `user_code` is the non-IT party, `it_code` the IT party (both None-able).
    `other_code` is only used when there is no IT side, to name the second party.
    `history` is every live handover for this device.
    """
    pair = {c for c in (user_code, it_code, other_code) if c}

    # 1. Already recorded. Must come first: re-importing a hand-out that was
    #    already applied leaves the machine on the receiver's name, and rule 2
    #    would then read that as a return and silently reverse the ownership.
    if len(pair) == 2:
        for h in history:
            if {h.get("from_user_id"), h.get("to_user_id")} == pair:
                flow = RETURN if h.get("to_user_id") == it_code else ISSUE
                owner_after = (
                    GHOST_CODE if flow == RETURN else h.get("to_user_id")
                )
                return _decision(
                    flow,
                    h.get("from_user_id"),
                    h.get("to_user_id"),
                    owner_after,
                    device,
                    "Đã có bản ghi bàn giao cho đúng thiết bị và đúng hai người này "
                    f"({h.get('handover_date')}) — giữ nguyên chiều đã ghi.",
                    duplicate_of=h,
                )

    # No IT side at all: a person-to-person transfer. Whoever holds it gives it.
    if not it_code:
        holder = (device or {}).get("user_id")
        first, second = user_code, other_code
        if holder and holder == other_code:
            first, second = other_code, user_code
        return _decision(
            TRANSFER, first, second, second, device,
            "Không bên nào là IT — chuyển máy giữa hai người dùng.",
        )

    # 2. This person has held the machine before → they are giving it back.
    #    Dates are not used to filter: hand-entered rows carry the entry date, not
    #    the date on the minutes, so a date window would drop real history.
    if user_code and any(
        h.get("from_user_id") == user_code or h.get("to_user_id") == user_code
        for h in history
    ):
        return _decision(
            RETURN, user_code, it_code, GHOST_CODE, device,
            f"{user_code} từng giữ thiết bị này trong lịch sử bàn giao → trả về IT.",
        )

    owner = (device or {}).get("user_id")

    # 3. Stands in their name with nothing to explain how it got there. A return
    #    and a hand-assigned owner look identical from here, so don't guess.
    if owner and owner == user_code:
        return _decision(
            RETURN, user_code, it_code, GHOST_CODE, device,
            f"Thiết bị đang đứng tên {user_code} nhưng không có lịch sử bàn giao "
            "nào — chưa rõ là trả máy hay đã gán tay trước đó.",
            ambiguous=True,
        )

    # 5. Held by someone the minutes never mention.
    if owner and owner not in (GHOST_CODE, it_code, user_code):
        return _decision(
            ISSUE, it_code, user_code, user_code, device,
            f"Thiết bị đang thuộc {owner}, không phải bên nào trong biên bản.",
            ambiguous=True,
        )

    # 4. New machine, or sitting in the store → IT is handing it out. The common
    #    case, including a one-line record with no return row.
    where = "chưa có trong hệ thống" if device is None else "đang ở kho (IT-STORE)"
    return _decision(
        ISSUE, it_code, user_code, user_code, device,
        f"Thiết bị {where} và {user_code or 'người nhận'} chưa từng giữ nó → "
        "bàn giao máy đi.",
    )


def apply_flow(flow: str, *, user_code: str | None, it_code: str | None,
               device: dict | None) -> dict:
    """The from/to/owner/status a flow implies — used when a human overrides the
    inferred direction, so the override goes through the same rule as the guess."""
    if flow == RETURN:
        return {
            "from_user_id": user_code,
            "to_user_id": it_code,
            "device_owner_after": GHOST_CODE,
            "device_status_after": _status_after(
                GHOST_CODE, (device or {}).get("status")
            ),
        }
    return {
        "from_user_id": it_code,
        "to_user_id": user_code,
        "device_owner_after": user_code,
        "device_status_after": _status_after(
            user_code, (device or {}).get("status")
        ),
    }
