"""Handover-minutes import — thin HTTP layer over be/handover_import.py.

Three steps, deliberately separate so nothing is written before a human has seen
what will happen:

  POST /imports/handover/read   file → structured fields   (read-only)
  POST /imports/handover/plan   fields → what would change (read-only)
  POST /imports/handover/apply  decisions → writes         (one transaction)

`read` tries `be/handover_sheet.py` first — the company template is a fixed form,
and parsing it costs under a millisecond against the ~25s warm (~70s cold) an 8B
model takes — and falls back to the LLM (`be/llm.read_handover_minutes`) for a
scan, a photo, or an off-template file. Either way it throws away anything that
isn't actually in the file. `plan` reconciles against the ledger and works out each
line's direction in plain code. `apply` executes the decisions the user confirmed
and logs whatever is still unsettled to import_issues, which backs the
Notifications screen.

`read` exists twice over ONE implementation (`_read_events`): the plain endpoint
drains it and answers once, `/read/stream` forwards each step as SSE so the screen
can show a progress bar that is counting something real rather than animating.
"""
import base64
import binascii
import json
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import (
    extract,
    handover_direction,
    handover_import,
    handover_sheet,
    import_detect,
    llm,
)
from ..db import get_pool
from ..handover_import import GHOST_CODE, ISSUE, RETURN, TRANSFER
from ..models.device import DeviceCreate, DeviceUpdate
from ..models.handover import HandoverCreate
from ..models.user import UserCreate, UserUpdate
from ..repositories import device as device_repo
from ..repositories import handover as handover_repo
from ..repositories import import_issues as issues_repo
from ..repositories import user as user_repo
from ..repositories.errors import DuplicateError, ForeignKeyError

router = APIRouter(prefix="/imports", tags=["imports"])

# A PDF is not downscaled the way the assistant downscales images, so cap the
# decoded size rather than letting an arbitrary upload through.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# Device columns the minutes can fill. buy_date/barcode/os/msoffice are never in a
# handover record, which is exactly why a device created from one is incomplete.
MINUTES_DEVICE_FIELDS = ("type", "brand", "cpu", "ram", "storage", "name")
COMPLETION_FIELDS = ("barcode", "buy_date", "os", "msoffice")


# --------------------------------------------------------------------- models

class Attachment(BaseModel):
    name: str
    mime: str = ""
    data: str  # base64-encoded file bytes


class ReadRequest(BaseModel):
    """Either the sheet already flattened in the browser, or a file to extract."""
    sheet_text: str | None = None
    attachment: Attachment | None = None
    # "auto" reads the form in plain code when it can and asks the model when it
    # can't. "llm" skips straight to the model — what the screen's "read with AI
    # instead" retry sends when a parse came back looking wrong.
    reader: str = "auto"


class ReadResult(BaseModel):
    parsed: dict
    warnings: list[str] = []
    source_text: str
    # Which of the two read it, so the screen can say so — a record read in plain
    # code and one read by an 8B model do not deserve the same amount of trust.
    reader: str = "llm"
    # Numbered rows the file's own item table has. The denominator of the progress
    # bar, and worth reporting even on the fast path: it is what says "1 of 15 read"
    # rather than "reading…".
    item_rows: int = 0


class PlanRequest(BaseModel):
    parsed: dict
    source_file: str | None = None
    it_index: int | None = None  # index into parsed["parties"] — user override


class UserDecision(BaseModel):
    code: str
    action: str = "reuse"  # create | update | reuse
    name: str | None = None
    team: str | None = None


class ItemDecision(BaseModel):
    """One movement the operator confirmed.

    `from_user_id` / `to_user_id` are the authoritative pair — they are the only
    thing that can describe a record with three parties, where "the flow" no
    longer pins down who is at each end. `flow` is re-derived from them and is
    read directly only for `"skip"` and for a two-party caller that sends nothing
    else.
    """
    serial: str
    flow: str  # return | issue | transfer | skip
    row: int | None = None
    from_user_id: str | None = None
    to_user_id: str | None = None
    handover_id: str | None = None
    handover_date: str | None = None
    reason: str | None = None
    create_device: bool = False
    device_fields: dict = {}


class ApplyRequest(BaseModel):
    source_file: str | None = None
    handover_date: str | None = None
    party_codes: list[str] = []
    it_code: str | None = None
    users: list[UserDecision] = []
    items: list[ItemDecision] = []
    issues: list[dict] = []  # left unresolved by the user → logged as open


class ApplyResult(BaseModel):
    users_created: int = 0
    users_updated: int = 0
    devices_created: int = 0
    devices_updated: int = 0
    handovers_created: int = 0
    handovers_skipped: int = 0
    issues_logged: int = 0


# ----------------------------------------------------------------------- read

async def _source_text(req: ReadRequest) -> str:
    """The text the model reads and is checked against."""
    if req.sheet_text and req.sheet_text.strip():
        return req.sheet_text
    if req.attachment is None:
        raise HTTPException(400, "Cần sheet_text hoặc attachment.")
    try:
        raw = base64.b64decode(req.attachment.data, validate=False)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "Dữ liệu base64 của file bị lỗi.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"File quá lớn ({len(raw) // 1024 // 1024} MB), tối đa 20 MB."
        )
    result = await extract.extract_file(
        req.attachment.name, req.attachment.mime, raw
    )
    parts = [(result.get("text") or "").strip()]
    for table in result.get("tables") or []:
        markdown = (table.get("markdown") or "").strip()
        if markdown:
            parts.append(markdown)
    text = "\n\n".join(p for p in parts if p)
    if not text:
        raise HTTPException(422, "Không trích xuất được nội dung nào từ file này.")
    return text


# --------------------------------------------------------- progress, as events
#
# Both slow endpoints here are written once, as a generator of `{"phase": …}` events
# ending in `{"phase": "done", "result": …}`. The plain endpoint drains it and
# answers once; the `/stream` twin forwards each event as SSE. Neither duplicates
# the other's logic, so a phase cannot exist in one and not the other.
#
# What earns the machinery is that these waits are long and lumpy. A scanned record
# is OCR'd for tens of seconds; a cold model spends ~44s loading before it writes a
# character. A spinner cannot tell either of those from a hang.

EXTRACT = "extract"    # uploading + OCR'ing a PDF or a photo
MATCHING = "matching"  # keyword/header heuristics — instant
ASKING = "asking"      # the heuristics were unsure, so the model is being asked


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _event_stream(events: AsyncIterator[dict]) -> StreamingResponse:
    """Forward a phase generator as Server-Sent Events.

    An HTTPException has to be delivered as an event rather than a status code: the
    200 was sent before the first phase ran. A client that ignored that would wait
    forever on a file the server had already rejected.
    """
    async def body() -> AsyncIterator[str]:
        try:
            async for event in events:
                yield _sse(event)
        except HTTPException as e:
            yield _sse({"phase": "error", "status": e.status_code, "detail": e.detail})

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        # Caddy fronts this in production. It does not buffer proxied responses by
        # default and the stream was verified arriving event-by-event through it,
        # but the hint costs nothing and says what the endpoint needs.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class DetectResult(BaseModel):
    kind: str
    reason: str
    confident: bool
    used_llm: bool = False
    source_text: str


async def _detect_events(req: ReadRequest) -> AsyncIterator[dict]:
    """`detect_import_kind`, reporting each step. One implementation, two transports.

    Worth streaming for the same reason the read is: on a PDF or a photo the
    `extract` phase is an OCR pass that can run for tens of seconds, and it happens
    HERE rather than during the read — the extracted text is handed on so a scan is
    never OCR'd twice. A queue row spinning silently through that is the longest
    unexplained wait left in the importer.
    """
    if req.attachment is not None and not (req.sheet_text or "").strip():
        yield {"phase": EXTRACT, "name": req.attachment.name}
    source_text = await _source_text(req)

    yield {"phase": MATCHING}
    result = import_detect.detect_kind(source_text)
    used_llm = False
    if not result["confident"]:
        yield {"phase": ASKING}
        result = await import_detect.detect_kind_with_llm(source_text, llm._chat)
        used_llm = True
    yield {
        "phase": "done",
        "result": {**result, "used_llm": used_llm, "source_text": source_text},
    }


@router.post("/detect", response_model=DetectResult)
async def detect_import_kind(req: ReadRequest):
    """Which importer does this file belong to? Read-only, no database access.

    Heuristics answer first and cost nothing; the LLM is only asked when they are
    unsure (see be/import_detect). The caller always shows the answer with an
    override, so being wrong costs one click rather than corrupting anything.
    """
    async for event in _detect_events(req):
        if event["phase"] == "done":
            return event["result"]
    raise HTTPException(422, "Không nhận dạng được file này.")


@router.post("/detect/stream")
async def detect_import_kind_stream(req: ReadRequest):
    """The same detection, as SSE, so a queue row can say what it is waiting on."""
    return _event_stream(_detect_events(req))


# Steps a read passes through, in the order they happen. `extract` and the two LLM
# phases are the slow ones and are the reason this is reported at all: a scan is
# OCR'd for tens of seconds, and a cold model spends ~44s in `loading` before it
# writes a single character.
SCANNING = "scanning"  # locating the form's own table; `total` is settled here
VERIFYING = "verifying"  # checking every value back against the file
NO_READING = "Không đọc được biên bản: dịch vụ AI không phản hồi. Thử lại sau."


async def _read_events(req: ReadRequest) -> AsyncIterator[dict]:
    """Read a handover record into fields, reporting each step as it goes.

    The single implementation behind both read endpoints. Reads nothing from and
    writes nothing to the database — pure file → JSON. Every event carries `phase`;
    the last one is `{"phase": "done", "result": …}`.

    May raise HTTPException, which is right for the plain endpoint and is why
    `_read_stream` has to catch it: a streaming response has already sent 200 by
    the time the body is being produced.
    """
    if req.attachment is not None and not (req.sheet_text or "").strip():
        # Only worth announcing when there is something to extract — a spreadsheet
        # was flattened in the browser and arrives as text.
        yield {"phase": EXTRACT, "name": req.attachment.name}
    source_text = await _source_text(req)

    total = handover_sheet.count_item_rows(source_text)
    yield {"phase": SCANNING, "total": total}

    reader = "sheet"
    raw = None if req.reader == "llm" else handover_sheet.read_sheet(source_text)
    if raw is None:
        reader = "llm"
        async for event in llm.read_handover_minutes_stream(source_text):
            if event["phase"] == llm.DONE:
                raw = event["parsed"]
            else:
                yield {**event, "total": total}
    if not raw:
        raise HTTPException(503, NO_READING)

    yield {"phase": VERIFYING, "total": total}
    parsed, warnings = handover_import.verify_parsed(raw, source_text)
    yield {
        "phase": "done",
        "result": {
            "parsed": parsed,
            "warnings": warnings,
            "source_text": source_text,
            "reader": reader,
            "item_rows": total,
        },
    }


@router.post("/handover/read", response_model=ReadResult)
async def read_handover(req: ReadRequest):
    """Read a handover record into fields. Reads nothing from and writes nothing
    to the database — pure file → JSON."""
    async for event in _read_events(req):
        if event["phase"] == "done":
            return event["result"]
    raise HTTPException(503, NO_READING)


@router.post("/handover/read/stream")
async def read_handover_stream(req: ReadRequest):
    """The same read, as SSE, so the screen can show progress rather than a spinner.

    Reading a record is the longest wait in this importer: tens of seconds for a
    scan, and up to ~70s for a fifteen-row record if the model has to be loaded
    first.
    """
    return _event_stream(_read_events(req))


@router.post("/llm/warm")
async def warm_llm():
    """Ask the model server to make the model resident. Fire-and-forget.

    Ollama drops the weights after ten idle minutes and loading llama3.1:8b costs
    ~44 seconds, which the first import of the morning paid in full before reading
    a single field. The import dialog calls this when it opens, so the load overlaps
    the time a human spends choosing a file. Never fails the caller.
    """
    return {"warm": await llm.warm()}


# ----------------------------------------------------------------------- plan

def _reconcile_fields(current: dict, proposed: dict) -> tuple[dict, list[dict]]:
    """Split the minutes against the ledger: values that FILL an empty column, and
    values that CONTRADICT a stored one.

    Only the second needs a human. Filling in `position` is not a disagreement —
    almost nobody in the ledger has one, so treating an empty column as a conflict
    buried the Notifications screen under a row per party per import. A fill is
    written silently; a contradiction is still never guessed at.
    """
    fills: dict = {}
    conflicts: list[dict] = []
    for field, value in proposed.items():
        if value is None:
            continue
        now = current.get(field)
        if (now or None) is None:
            fills[field] = value
        elif handover_import.fold(now) != handover_import.fold(value):
            conflicts.append({"field": field, "current": now, "proposed": value})
    return fills, conflicts


def _closest_team(value: str | None, teams: list[str]) -> str | None:
    """Nearest team already in use, so "QA" can suggest the existing "QA/QC"
    instead of starting a second spelling."""
    if not value:
        return None
    target = handover_import.fold(value)
    for team in teams:
        if handover_import.fold(team) == target:
            return team
    for team in teams:
        folded = handover_import.fold(team)
        if folded.startswith(target) or target.startswith(folded):
            return team
    return next((t for t in teams if target in handover_import.fold(t)), None)


def _split_code(code: str) -> tuple[str, str]:
    """Employee code → (leading letters, the rest). "VPHN349" → ("VPHN", "349")."""
    i = 0
    while i < len(code) and code[i].isalpha():
        i += 1
    return code[:i].upper(), code[i:]


def _edits(a: str, b: str) -> int:
    """Levenshtein distance. Codes are ~7 characters, so the naive table is fine."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        row = [i]
        for j, cb in enumerate(b, 1):
            row.append(min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = row
    return prev[-1]


def _confusable(a: str | None, b: str | None) -> bool:
    """Two employee codes a human could plausibly have typed for each other.

    Sharing a name is NOT enough on its own. The ledger holds fifteen same-name
    pairs and almost all of them are deliberate: an intern keeps their TTS0xx code
    and gains a VPHNxxx one, so TTS010/VPHN318 is one person with two real records,
    not a typo. Flagging those as "trùng tên, khác mã" trained the team to ignore
    the screen. What IS worth interrupting for is VPHN349/VHPN351 — same length,
    prefix letters transposed — which is how one person became two rows.
    """
    if not a or not b or a == b or len(a) != len(b):
        return False
    pa, _ = _split_code(a)
    pb, _ = _split_code(b)
    # Transposed prefix: same letters, wrong order (VPHN ↔ VHPN).
    if pa != pb and sorted(pa) == sorted(pb):
        return True
    # One slipped character anywhere in the code (VPHN349 ↔ VPHN340).
    return _edits(a.upper(), b.upper()) <= 1


async def _namesakes(pool, name: str | None, code: str | None) -> list[dict]:
    """People stored under this same name whose CODE looks like a mistyping of this
    one — see _confusable for why the name alone is not a signal.

    Never merged automatically: FKs reach devices and handovers, so a human rules
    on it. Checked whether or not the code in the minutes exists.
    """
    if not name:
        return []
    folded = handover_import.fold(name)
    return [
        u for u in await user_repo.search(pool, name)
        if u["employee_code"] != code
        and handover_import.fold(u.get("name")) == folded
        and _confusable(code, u["employee_code"])
    ]


async def _plan_user(
    pool, party: dict, label: str, teams: list[str], current: dict | None
) -> dict:
    """Reconcile one party against the ledger. Read-only.

    `current` is the party's stored row, fetched in bulk by the caller — a record
    can carry any number of parties, and re-reading each one here made that a
    query per signature.
    """
    code = party.get("code")
    # The minutes also carry Chức vụ, but there is nowhere to put it: the users
    # table stores a department, not a job title. It still decides which party is
    # the IT side (see handover_import.detect_it_side) — it is just never written.
    proposed = {
        "name": party.get("name"),
        "team": party.get("dept"),
    }
    suggestion = _closest_team(proposed["team"], teams)
    plan = {
        "label": label,
        "code": code,
        "proposed": proposed,
        "team_suggestion": suggestion,
        "current": None,
        "action": "skip",
        "fills": {},
        "issues": [],
    }
    if not code:
        plan["issues"].append({
            "kind": "user_field_conflict",
            "resource": "users",
            "item_id": None,
            "payload": {"label": label, "reason": "Không đọc được mã nhân viên."},
        })
        return plan

    # A code that looks mistyped for someone with the same name — never merged
    # automatically, and never passed over in silence either.
    namesakes = await _namesakes(pool, party.get("name"), code)
    if namesakes:
        plan["issues"].append({
            "kind": "user_code_mismatch",
            "resource": "users",
            "item_id": code,
            "payload": {
                "label": label, "code": code, "name": party.get("name"),
                "candidates": namesakes,
            },
        })

    if current is None:
        # Creating a person the minutes name is the expected outcome, not a pending
        # decision — it is reported in the apply summary, not the Notifications
        # backlog.
        plan["action"] = "create"
        plan["fills"] = {k: v for k, v in proposed.items() if v is not None}
        if suggestion and plan["fills"].get("team"):
            plan["fills"]["team"] = suggestion
        return plan

    plan["current"] = current
    fills, conflicts = _reconcile_fields(current, proposed)
    # An existing team spelled a new way ("QA" for the ledger's "QA/QC") fills the
    # blank with the spelling already in use rather than starting a second one.
    if suggestion and fills.get("team"):
        fills["team"] = suggestion
    plan["fills"] = fills
    if conflicts:
        plan["issues"].append({
            "kind": "user_field_conflict",
            "resource": "users",
            "item_id": code,
            "payload": {
                "label": label, "code": code, "fields": conflicts,
                "team_suggestion": suggestion,
            },
        })
    plan["action"] = "update" if (fills or conflicts) else "reuse"
    return plan


def _plan_item(item: dict, *, ctx: handover_direction.Context, row: int) -> dict:
    """Reconcile one movement and resolve its direction. Read-only.

    Takes the ledger state through `ctx` rather than fetching it, so a record's
    rows cost two queries between them instead of two each — and so that the
    second movement of one device can be handed the first one's effect. See
    plan_handover.
    """
    serial = item["serial"]
    device = ctx.device
    decision = handover_direction.decide(
        ctx,
        handover_direction.Movement(row=row, serial=serial, note=item.get("note")),
    )
    proposed_device = {
        f: item.get("device", {}).get(f) for f in MINUTES_DEVICE_FIELDS
    }
    plan = {
        **decision,
        "row": row,
        "no": item.get("no"),
        "serial": serial,
        "note": item.get("note"),
        "detail": item.get("detail"),
        "current_device": device,
        "proposed_device": proposed_device,
        "device_action": "reuse",
        "device_fills": {},
        "issues": [],
    }

    if device is None:
        plan["device_action"] = "create"
        plan["device_fills"] = {
            k: v for k, v in proposed_device.items() if v is not None
        }
        plan["issues"].append({
            "kind": "device_created_incomplete",
            "resource": "devices",
            "item_id": serial,
            "payload": {
                "row": row,
                "serial": serial,
                "created_from": proposed_device,
                "missing": list(COMPLETION_FIELDS),
            },
        })
    else:
        fills, conflicts = _reconcile_fields(device, proposed_device)
        plan["device_fills"] = fills
        if conflicts:
            plan["issues"].append({
                "kind": "device_field_conflict",
                "resource": "devices",
                "item_id": serial,
                "payload": {"row": row, "serial": serial, "fields": conflicts},
            })
        if fills or conflicts:
            plan["device_action"] = "update"

    if decision.get("duplicate_of"):
        plan["issues"].append({
            "kind": "handover_duplicate",
            "resource": "handovers",
            "item_id": serial,
            "payload": {
                "row": row,
                "serial": serial,
                "existing": decision["duplicate_of"],
                "proposed_date": item.get("_date"),
            },
        })
    if decision.get("ambiguous"):
        plan["issues"].append({
            "kind": "flow_ambiguous",
            "resource": "handovers",
            "item_id": serial,
            "payload": {
                "row": row,
                "serial": serial,
                "reason": decision.get("flow_reason"),
                "guess": decision.get("flow"),
                "source": decision.get("direction_source"),
            },
        })
    return plan


@router.post("/handover/plan")
async def plan_handover(req: PlanRequest, pool=Depends(get_pool)):
    """What importing this record would do. Writes nothing."""
    parsed = req.parsed or {}
    raw_parties = [p for p in (parsed.get("parties") or []) if isinstance(p, dict)]

    # One round trip for every party, however many signed.
    stored = await user_repo.get_many(
        pool, [p["code"] for p in raw_parties if p.get("code")]
    )
    party_users = [stored.get(p.get("code")) if p.get("code") else None
                   for p in raw_parties]

    if req.it_index is not None and 0 <= req.it_index < len(raw_parties):
        it_index, it_reason = req.it_index, "Bên IT do người dùng chọn."
    else:
        it_index, it_reason = handover_import.detect_it_side(raw_parties, party_users)
    it_code = raw_parties[it_index].get("code") if it_index is not None else None

    parties = tuple(
        handover_direction.Party(
            label=p.get("label") or "?",
            code=p.get("code"),
            name=p.get("name"),
            dept=p.get("dept"),
            position=p.get("position"),
        )
        for p in raw_parties
    )

    teams = await user_repo.list_teams(pool)
    party_plans = [
        await _plan_user(pool, p, f"Bên {p.get('label') or '?'}", teams, stored_user)
        for p, stored_user in zip(raw_parties, party_users)
    ]

    raw_items = [i for i in (parsed.get("items") or []) if i.get("serial")]
    serials = [i["serial"] for i in raw_items]
    devices = await device_repo.get_many(pool, serials)
    histories = await handover_repo.list_by_devices(pool, serials)

    # Movements are planned in row order against state that carries forward, so a
    # record moving one device twice (A→B, then B→C) reads B as the second row's
    # giver instead of planning both rows from the same starting row.
    #
    # Only the DEVICE is threaded, never the pending handover: feeding row 1's own
    # row into row 2's history would make row 2 report itself as already recorded
    # and freeze the direction it was about to be given.
    items = []
    for index, raw in enumerate(raw_items, start=1):
        serial = raw["serial"]
        row = raw.get("row") or index
        item = _plan_item(
            {**raw, "_date": parsed.get("handover_date")},
            ctx=handover_direction.Context(
                parties=parties,
                it_code=it_code,
                device=devices.get(serial),
                history=tuple(histories.get(serial, [])),
            ),
            row=row,
        )
        items.append(item)
        devices[serial] = {
            **(devices.get(serial) or {"serial_number": serial}),
            **item["device_fills"],
            "user_id": item["device_owner_after"],
            "status": item["device_status_after"],
        }

    return {
        "source_file": req.source_file,
        "handover_date": parsed.get("handover_date"),
        "place": parsed.get("place"),
        "it_index": it_index,
        "it_reason": it_reason,
        "it_code": it_code,
        "parties": party_plans,
        "items": items,
        "issue_count": sum(len(p["issues"]) for p in party_plans)
        + sum(len(i["issues"]) for i in items),
    }


# ---------------------------------------------------------------------- apply

def _written_state(
    req: ApplyRequest, item: ItemDecision, device: dict | None
) -> tuple[dict, str]:
    """The handover row and device state one confirmed movement implies.

    The movement's own `from`/`to` win, and the flow is re-derived from them — a
    client never gets to name the owner. When only a flow arrives (a two-party
    caller, where naming the flow does still pin the pair down) the counterpart is
    the record's single non-IT party.
    """
    from_code, to_code = item.from_user_id, item.to_user_id
    if not (from_code or to_code):
        others = [c for c in req.party_codes if c and c != req.it_code]
        after = handover_import.apply_flow(
            item.flow,
            user_code=others[0] if len(others) == 1 else None,
            it_code=req.it_code,
            device=device,
        )
        return after, item.flow

    owner = handover_direction.owner_after(to_code, req.it_code, device)
    return {
        "from_user_id": from_code,
        "to_user_id": to_code,
        "device_owner_after": owner,
        "device_status_after": handover_import.status_after(
            owner, (device or {}).get("status")
        ),
    }, handover_direction.flow_of(from_code, to_code, req.it_code)


@router.post("/handover/apply", response_model=ApplyResult)
async def apply_handover(req: ApplyRequest, pool=Depends(get_pool)):
    """Execute the confirmed decisions. All-or-nothing: users, devices, handovers
    and the issue log share one transaction, so a failure halfway cannot leave a
    handover pointing at a device that was rolled back."""
    result = ApplyResult()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for decision in req.users:
                if decision.action == "create":
                    try:
                        # Nested = SAVEPOINT. Postgres aborts the whole transaction
                        # on a failed INSERT, so without one the fallback UPDATE
                        # below dies with InFailedSQLTransactionError and the
                        # recovery this except clause exists for never happens.
                        async with conn.transaction():
                            await user_repo.create(conn, UserCreate(
                                employee_code=decision.code,
                                name=decision.name,
                                team=decision.team,
                            ))
                        result.users_created += 1
                    except DuplicateError:
                        # Created by a concurrent import between plan and apply, or
                        # by an earlier file in the same bulk run — fall through to
                        # an update rather than failing the batch.
                        decision.action = "update"
                if decision.action == "update":
                    await user_repo.update(conn, decision.code, UserUpdate(
                        **{
                            k: v for k, v in {
                                "name": decision.name,
                                "team": decision.team,
                            }.items() if v is not None
                        }
                    ))
                    result.users_updated += 1

            for item in req.items:
                if item.flow == "skip":
                    result.handovers_skipped += 1
                    continue
                if item.flow not in handover_import.FLOWS:
                    raise HTTPException(400, f"Luồng không hợp lệ: {item.flow}")

                fields = {
                    k: v for k, v in (item.device_fields or {}).items()
                    if k in MINUTES_DEVICE_FIELDS and v is not None
                }
                # Domain errors from the repos (DuplicateError / ForeignKeyError)
                # propagate to the 409 handler in main.py; leaving the transaction
                # is what rolls the whole apply back, same as before.
                device = current = await device_repo.get(conn, item.serial)
                if current is None:
                    if not item.create_device:
                        raise HTTPException(
                            409,
                            f"Thiết bị {item.serial} chưa có trong hệ thống. "
                            "Bật tạo mới hoặc bỏ qua dòng này.",
                        )
                    device = await device_repo.create(conn, DeviceCreate(
                        serial_number=item.serial, status="in_stock",
                        user_id=GHOST_CODE, **fields,
                    ))
                    result.devices_created += 1
                elif fields:
                    device = await device_repo.update(
                        conn, item.serial, DeviceUpdate(**fields)
                    )
                    result.devices_updated += 1

                # `device` is the row we just wrote (or `current`, untouched) —
                # re-reading it here was a wasted round-trip per line item and a
                # read-your-own-write hazard for no gain.
                #
                # The movement's own pair is authoritative. It used to be
                # recomputed here from one record-level pair, which is what wrote
                # every row of a three-party record between the same two people.
                after, flow = _written_state(req, item, device)

                await handover_repo.create(conn, HandoverCreate(
                    handover_id=item.handover_id or str(uuid.uuid4()),
                    handover_date=item.handover_date or req.handover_date,
                    device_id=item.serial,
                    from_user_id=after["from_user_id"],
                    to_user_id=after["to_user_id"],
                    reason=(item.reason or _default_reason(flow))[:100],
                ))
                result.handovers_created += 1

                await device_repo.update(conn, item.serial, DeviceUpdate(
                    user_id=after["device_owner_after"],
                    status=after["device_status_after"],
                ))

            if req.issues:
                try:
                    logged = await issues_repo.create_many(conn, [
                        {**i, "source_file": req.source_file} for i in req.issues
                    ])
                except ValueError as e:  # unknown kind — a client bug, not a 500
                    raise HTTPException(400, str(e))
                result.issues_logged = len(logged)
    return result


def _default_reason(flow: str) -> str:
    return {
        RETURN: "Trả về IT",
        ISSUE: "Bàn giao máy mới",
        TRANSFER: "Chuyển máy giữa hai người dùng",
    }.get(flow, "Bàn giao")


# --------------------------------------------------------------------- issues

class IssueResolution(BaseModel):
    status: str  # resolved | dismissed | open
    resolution: dict | None = None


@router.get("/issues")
async def list_issues(status: str | None = "open", pool=Depends(get_pool)):
    """Open issues back the Notifications screen; `status=all` reads the full log."""
    try:
        return await issues_repo.list_issues(
            pool, status=None if status in (None, "", "all") else status
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/issues/count")
async def count_issues(pool=Depends(get_pool)):
    """Backs the nav badge."""
    return {"open": await issues_repo.count_open(pool)}


async def _still_stands(
    pool, issue: dict, current: dict | None
) -> tuple[bool, str | None]:
    """Is this open issue still true of the ledger? Returns (stands, why-not).

    The backlog goes stale on its own: someone fills the missing specs from the
    Devices screen, or corrects a team on the person's own row, and the issue that
    asked for exactly that is still sitting there. Rather than trust every editing
    path to remember to close it, the truth is re-derived from the data.

    `current` is the referenced row, fetched in bulk by the caller — see
    recheck_issues. `pool` is still needed for the one write this can make.
    """
    kind, item_id = issue["kind"], issue.get("item_id")
    payload = issue.get("payload") or {}
    if not item_id:
        return True, None  # nothing to check it against — a human still rules
    if issue["resource"] not in ("users", "devices"):
        return True, None  # handover-scoped issues have no single row to re-read

    if current is None:
        return False, f"{item_id} không còn trong hệ thống."

    if kind == "device_created_incomplete":
        missing = [f for f in COMPLETION_FIELDS if (current.get(f) or None) is None]
        if not missing:
            return False, "Đã bổ sung đủ thông tin thiết bị."
        # Still incomplete, but perhaps less so — keep the list honest.
        if missing != (payload.get("missing") or []):
            payload["missing"] = missing
            await issues_repo.update_payload(pool, issue["id"], payload)
        return True, None

    if kind in ("user_field_conflict", "device_field_conflict"):
        fields = payload.get("fields")
        if not isinstance(fields, list) or not fields:
            return True, None
        settled = all(
            (current.get(f["field"]) or None) is not None
            and handover_import.fold(current.get(f["field"]))
            != handover_import.fold(f.get("current"))
            for f in fields
        )
        if settled:
            return False, "Thông tin đã được sửa."
    return True, None


@router.post("/issues/recheck")
async def recheck_issues(pool=Depends(get_pool)):
    """Close open issues the ledger has already answered.

    Called by the Notifications screen before it lists, so fixing the data by any
    route — this screen, the Devices editor, a later import — makes the row go
    away, instead of leaving a job that was done days ago at the top of the list.
    """
    issues = await issues_repo.list_issues(pool, status=issues_repo.OPEN, limit=500)

    # Two queries for the whole backlog rather than one per issue. This used to
    # re-read the referenced row inside the loop, so a full backlog cost up to
    # 500 x 3 sequential round-trips in a single request — and the Notifications
    # screen calls this before every list.
    rows_by_resource = {
        "users": await user_repo.get_many(
            pool, [i["item_id"] for i in issues
                   if i["resource"] == "users" and i.get("item_id")]
        ),
        "devices": await device_repo.get_many(
            pool, [i["item_id"] for i in issues
                   if i["resource"] == "devices" and i.get("item_id")]
        ),
    }

    closed = 0
    for issue in issues:
        current = rows_by_resource.get(issue["resource"], {}).get(issue.get("item_id"))
        stands, why = await _still_stands(pool, issue, current)
        if stands:
            continue
        # "Gone" is dismissed, not resolved: nobody ruled on it, it stopped applying.
        status = (
            issues_repo.DISMISSED
            if "không còn trong hệ thống" in (why or "")
            else issues_repo.RESOLVED
        )
        await issues_repo.set_status(pool, issue["id"], status, {"auto": why})
        closed += 1
    return {"closed": closed}


@router.patch("/issues/{issue_id}")
async def resolve_issue(
    issue_id: int, body: IssueResolution, pool=Depends(get_pool)
):
    try:
        row = await issues_repo.set_status(
            pool, issue_id, body.status, body.resolution
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    if row is None:
        raise HTTPException(404, f"Import issue not found: {issue_id}")
    return row
