"""Which way does one line of a handover record move? Ranked evidence, not a ladder.

A handover record is **N parties and M movements**. A movement is one line of the
Contents table: one device changing hands once. Direction is a property of the
*movement*, never of the record — `ban giao Dana intern acc.xlsx` has three parties
and two rows, and neither row moves between the same pair:

    row 1  5CD33443JJ       note "271->TTS018"   Bên C → Bên B
    row 2  W5N0CV08Z072214  note "228->271"      Bên A (IT) → Bên C

The importer used to collapse a record to one `(it_code, user_code)` pair and
classify every row against it, so both of those rows were written wrong — row 2
confidently, which is the worse half.

**A resolver takes (Context, Movement) and returns a Direction or None.** None
means "I have nothing to say about this row"; the next resolver gets a turn.
`resolve()` walks `RESOLVERS` in order and falls back to an `unknown` direction
that is explicitly not confident, so the UI asks rather than the importer guessing.

Adding a signal is adding a function to `RESOLVERS` — which is exactly how the
`A->B` note convention was added to the five rules that were here before it.

Order carries meaning; see the comments on `RESOLVERS`. Everything here is pure —
no database, no I/O — so it tests synchronously.
"""
import re
from dataclasses import dataclass
from typing import Callable

from .constants import GHOST_CODE
from .handover_import import (
    ISSUE,
    RETURN,
    TRANSFER,
    fold,
    is_it_own_machine,
    status_after,
)

# Where a direction came from. Surfaced to the UI so a row can say why it points
# the way it does, and folded into the flow_ambiguous issue payload.
RECORDED = "recorded"
NOTE = "note"
TRANSFER_PAIR = "transfer"
HOLDER = "holder"
OWNER = "owner"
IT_COUNTERPART = "it"
UNKNOWN = "unknown"


@dataclass(frozen=True)
class Party:
    """One `Bên X/ Party X` block of the form."""
    label: str                      # "A", "B", "C" … whatever letter the form used
    code: str | None = None
    name: str | None = None
    dept: str | None = None
    position: str | None = None


@dataclass(frozen=True)
class Movement:
    """One line of the Contents table.

    `row` is the movement's identity, NOT `serial`: a single record may move the
    same device twice (A→B, then B→C), and keying on the serial silently merges
    the two into one.

    Only what a resolver actually reads lives here — the specs and quantity ride
    along in the router's own item dict.
    """
    row: int
    serial: str
    note: str | None = None


@dataclass(frozen=True)
class Context:
    """The record and the ledger, as of this movement.

    `device` and `history` are the state the movement *starts* from. When a record
    moves one device twice, the caller threads the first movement's effect into the
    second one's context — see `plan_handover`.
    """
    parties: tuple[Party, ...]
    it_code: str | None = None
    device: dict | None = None
    history: tuple[dict, ...] = ()

    @property
    def codes(self) -> tuple[str, ...]:
        """Every party's code, in form order, without blanks or repeats."""
        seen: dict[str, None] = {}
        for party in self.parties:
            if party.code:
                seen.setdefault(party.code, None)
        return tuple(seen)

    @property
    def other_codes(self) -> tuple[str, ...]:
        """The parties who are not the IT side."""
        return tuple(c for c in self.codes if c != self.it_code)


@dataclass(frozen=True)
class Direction:
    """Who gave and who received, plus why we believe it."""
    from_code: str | None
    to_code: str | None
    source: str
    reason: str
    confident: bool
    duplicate_of: dict | None = None


Resolver = Callable[[Context, Movement], Direction | None]


# ------------------------------------------------------------ the note arrow

# "271->TTS018", "A → C", "VPHN228 --> VPHN271". `=>` is in here because it is what
# a keyboard produces when Vietnamese IME is on.
_ARROW = re.compile(r"-+>|→|=+>|➔|➡")

# A code token is letters and digits; strip anything a human wrapped it in.
_EDGE_JUNK = re.compile(r"^[^0-9A-Za-z]+|[^0-9A-Za-z]+$")


def _match_party(token: str, parties: tuple[Party, ...]) -> str | None:
    """Resolve one side of an arrow to a party's employee code.

    Three ways, most specific first: the full code, the party's own label (so
    `A->C` reads as well as `VPHN228->VPHN271`), then a suffix that belongs to
    exactly one party (`271` → `VPHN271`, which is how the team writes it).

    Anything that matches two parties returns None rather than picking one — an
    ambiguous note is no evidence at all, and the next resolver gets its turn.
    """
    token = _EDGE_JUNK.sub("", token or "")
    if not token:
        return None
    folded = fold(token)

    for candidates in (
        [p for p in parties if p.code and fold(p.code) == folded],
        [p for p in parties if p.label and fold(p.label) == folded],
        [p for p in parties if p.code and fold(p.code).endswith(folded)],
    ):
        if len(candidates) == 1:
            return candidates[0].code
        if candidates:
            return None  # more than one party answers to this — no guessing
    return None


def parse_note_direction(
    note: str | None, parties: tuple[Party, ...] | list[Party]
) -> tuple[str, str] | None:
    """`"271->TTS018"` → `("VPHN271", "TTS018")`. None when it isn't one.

    The note is free text with a movement expression somewhere in it, so the token
    next to the arrow is the one that counts: "máy cũ 271 -> TTS018 nhận" resolves
    the same as "271->TTS018".

    Returns None — never a guess — unless both sides resolve to two *distinct*
    parties. A chain (`A->B->C`) is two movements written on one line, which this
    record shape cannot express, so it is left for a human.
    """
    if not note:
        return None
    parts = _ARROW.split(note)
    if len(parts) != 2:
        return None
    left, right = parts[0].split(), parts[1].split()
    if not left or not right:
        return None
    from_code = _match_party(left[-1], tuple(parties))
    to_code = _match_party(right[0], tuple(parties))
    if not from_code or not to_code or from_code == to_code:
        return None
    return from_code, to_code


# ------------------------------------------------------------------ resolvers

def from_recorded_handover(ctx: Context, movement: Movement) -> Direction | None:
    """This exact movement is already in the ledger — keep the direction it has.

    First for the reason the old rule chain had it first: re-importing a hand-out
    that was already applied leaves the machine on the receiver's name, and the
    prior-holder rule below would then read that as a return and silently reverse
    the ownership.
    """
    known = set(ctx.codes)
    for handover in ctx.history:
        pair = {handover.get("from_user_id"), handover.get("to_user_id")}
        if len(pair) == 2 and pair <= known:
            return Direction(
                handover.get("from_user_id"),
                handover.get("to_user_id"),
                RECORDED,
                "Đã có bản ghi bàn giao cho đúng thiết bị và đúng hai người này "
                f"({handover.get('handover_date')}) — giữ nguyên chiều đã ghi.",
                confident=True,
                duplicate_of=handover,
            )
    return None


def from_note_arrow(ctx: Context, movement: Movement) -> Direction | None:
    """The Ghi chú cell says which way it goes: `271->TTS018`.

    Below the recorded-handover check on purpose — what the ledger already did
    beats what the paper says it would do — but above every inference, because an
    explicitly written direction is not something to second-guess.
    """
    pair = parse_note_direction(movement.note, ctx.parties)
    if pair is None:
        return None
    from_code, to_code = pair
    return Direction(
        from_code, to_code, NOTE,
        f'Ô ghi chú "{(movement.note or "").strip()}" ghi rõ chiều '
        f"{from_code} → {to_code}.",
        confident=True,
    )


def from_transfer_pair(ctx: Context, movement: Movement) -> Direction | None:
    """Two parties, neither of them IT — a person-to-person transfer.

    Whoever holds the machine is the one giving it away. With three or more
    parties and no IT side there is no such shortcut, so this stands aside and the
    row ends up asking.
    """
    if ctx.it_code or len(ctx.parties) != 2:
        return None
    codes = ctx.codes
    if len(codes) != 2:
        return None
    first, second = codes
    holder = (ctx.device or {}).get("user_id")
    if holder and holder == second:
        first, second = second, first
    return Direction(
        first, second, TRANSFER_PAIR,
        "Không bên nào là IT — chuyển máy giữa hai người dùng.",
        confident=True,
    )


def from_prior_holder(ctx: Context, movement: Movement) -> Direction | None:
    """A party who appears in this device's history is giving it back to IT.

    Dates are deliberately not used to filter: hand-entered rows carry the entry
    date rather than the date on the minutes, so a date window would drop real
    history.

    With several parties in the history there is no single giver, so this stands
    aside rather than picking the first one.
    """
    if not ctx.it_code:
        return None
    holders = [
        code for code in ctx.other_codes
        if any(
            h.get("from_user_id") == code or h.get("to_user_id") == code
            for h in ctx.history
        )
    ]
    if len(holders) != 1:
        return None
    return Direction(
        holders[0], ctx.it_code, HOLDER,
        f"{holders[0]} từng giữ thiết bị này trong lịch sử bàn giao → trả về IT.",
        confident=True,
    )


def from_current_owner(ctx: Context, movement: Movement) -> Direction | None:
    """The device stands in someone's name with no history to explain how.

    Two shapes, both reported as needing a look:

    * a party in this record holds it — a return and a hand-assigned owner are
      indistinguishable from here, so don't pretend otherwise;
    * somebody the record never mentions holds it.
    """
    owner = (ctx.device or {}).get("user_id")
    if not owner or not ctx.it_code:
        return None

    if owner in ctx.other_codes:
        return Direction(
            owner, ctx.it_code, OWNER,
            f"Thiết bị đang đứng tên {owner} nhưng không có lịch sử bàn giao nào "
            "— chưa rõ là trả máy hay đã gán tay trước đó.",
            confident=False,
        )

    if owner == GHOST_CODE or owner == ctx.it_code:
        return None

    others = ctx.other_codes
    if len(others) != 1:
        return None  # a stranger holds it AND several parties could receive it
    return Direction(
        ctx.it_code, others[0], OWNER,
        f"Thiết bị đang thuộc {owner}, không phải bên nào trong biên bản.",
        confident=False,
    )


def from_it_counterpart(ctx: Context, movement: Movement) -> Direction | None:
    """New machine, or sitting in the store → IT is handing it out.

    The common case, including a one-line record with no return row. It only
    fires when the counterpart is unambiguous — an IT side and exactly one other
    party. With three parties there is nothing to make this the right guess, and
    guessing here is what put a laptop on the intern instead of its actual
    recipient.
    """
    if not ctx.it_code:
        return None
    others = ctx.other_codes
    if len(others) != 1:
        return None
    to_code = others[0]
    where = "chưa có trong hệ thống" if ctx.device is None else "đang ở kho (IT-STORE)"
    return Direction(
        ctx.it_code, to_code, IT_COUNTERPART,
        f"Thiết bị {where} và {to_code} chưa từng giữ nó → bàn giao máy đi.",
        confident=True,
    )


# The chain. Order is the design: the ledger's own record beats the paper, the
# paper beats inference, and every inference that could be two things says so.
RESOLVERS: tuple[Resolver, ...] = (
    from_recorded_handover,
    from_note_arrow,
    from_transfer_pair,
    from_prior_holder,
    from_current_owner,
    from_it_counterpart,
)

UNRESOLVED = Direction(
    None, None, UNKNOWN,
    "Không suy ra được chiều của dòng này — chọn bên giao và bên nhận.",
    confident=False,
)


def resolve(ctx: Context, movement: Movement) -> Direction:
    """First resolver with something to say wins; otherwise the row asks."""
    for resolver in RESOLVERS:
        direction = resolver(ctx, movement)
        if direction is not None:
            return direction
    return UNRESOLVED


# ------------------------------------------------------------------- derived

def flow_of(from_code: str | None, to_code: str | None, it_code: str | None) -> str:
    """RETURN / ISSUE / TRANSFER, read off the movement rather than inferred.

    Kept because the UI, the default reasons and `apply` all speak it — but it is
    now a description of a known direction, not a thing anybody has to guess.
    Takes bare codes so `apply` can derive it from what the operator confirmed.
    """
    if it_code and to_code == it_code:
        return RETURN
    if it_code and from_code == it_code:
        return ISSUE
    return TRANSFER


def owner_after(
    to_code: str | None, it_code: str | None, device: dict | None
) -> str | None:
    """Who the device stands with once this movement is written.

    A machine handed back to IT parks on the store, not on the individual who
    signed for it — IT staff hold one machine each and anything else in their name
    is unfiled stock. `is_it_own_machine` is the exception: the day IT replaced its
    own three laptops, those rows would otherwise have swept them into the store.

    Deliberately NOT routed through `store_recipient`, which gates on
    `looks_like_return(reason)`: an imported movement's reason is the note cell
    (`"271->TTS018"`), which is not a return phrase, so sharing that helper would
    park returned machines on the IT staffer's own name. The form path has to read
    a reason to find its direction; here the direction is already known.
    """
    if to_code and to_code == it_code and not is_it_own_machine(device):
        return GHOST_CODE
    return to_code


def decide(ctx: Context, movement: Movement) -> dict:
    """Resolve one movement and spell out everything that follows from it.

    A plain dict so it serialises straight to JSON. `ambiguous` is the inverse of
    `confident` and is kept because the Notifications payloads and the review
    screen both read it.
    """
    direction = resolve(ctx, movement)
    owner = owner_after(direction.to_code, ctx.it_code, ctx.device)
    return {
        "flow": flow_of(direction.from_code, direction.to_code, ctx.it_code),
        "from_user_id": direction.from_code,
        "to_user_id": direction.to_code,
        "device_owner_after": owner,
        "device_status_after": status_after(owner, (ctx.device or {}).get("status")),
        "flow_reason": direction.reason,
        "direction_source": direction.source,
        "confident": direction.confident,
        "ambiguous": not direction.confident,
        "duplicate_of": direction.duplicate_of,
    }
