"""Handover-minutes import — thin HTTP layer over be/handover_import.py.

Three steps, deliberately separate so nothing is written before a human has seen
what will happen:

  POST /imports/handover/read   file → structured fields   (read-only)
  POST /imports/handover/plan   fields → what would change (read-only)
  POST /imports/handover/apply  decisions → writes         (one transaction)

`read` uses the LLM (be/llm.read_handover_minutes) to locate fields in the
bilingual form, then throws away anything that isn't actually in the file. `plan`
reconciles against the ledger and works out each line's direction in plain code.
`apply` executes the decisions the user confirmed and logs whatever is still
unsettled to import_issues, which backs the Notifications screen.
"""
import base64
import binascii
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import extract, handover_import, import_detect, llm
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


class ReadResult(BaseModel):
    parsed: dict
    warnings: list[str] = []
    source_text: str


class PlanRequest(BaseModel):
    parsed: dict
    source_file: str | None = None
    it_side: str | None = None  # "a" | "b" | None — user override of the guess


class UserDecision(BaseModel):
    code: str
    action: str = "reuse"  # create | update | reuse
    name: str | None = None
    team: str | None = None


class ItemDecision(BaseModel):
    serial: str
    flow: str  # return | issue | transfer | skip
    handover_id: str | None = None
    handover_date: str | None = None
    reason: str | None = None
    create_device: bool = False
    device_fields: dict = {}


class ApplyRequest(BaseModel):
    source_file: str | None = None
    handover_date: str | None = None
    party_a_code: str | None = None
    party_b_code: str | None = None
    it_side: str | None = None
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


class DetectResult(BaseModel):
    kind: str
    reason: str
    confident: bool
    used_llm: bool = False
    source_text: str


@router.post("/detect", response_model=DetectResult)
async def detect_import_kind(req: ReadRequest):
    """Which importer does this file belong to? Read-only, no database access.

    Heuristics answer first and cost nothing; the LLM is only asked when they are
    unsure (see be/import_detect). The caller always shows the answer with an
    override, so being wrong costs one click rather than corrupting anything.
    """
    source_text = await _source_text(req)
    result = import_detect.detect_kind(source_text)
    used_llm = False
    if not result["confident"]:
        result = await import_detect.detect_kind_with_llm(source_text, llm._chat)
        used_llm = True
    return {**result, "used_llm": used_llm, "source_text": source_text}


@router.post("/handover/read", response_model=ReadResult)
async def read_handover(req: ReadRequest):
    """Read a handover record into fields. Reads nothing from and writes nothing
    to the database — pure file → JSON."""
    source_text = await _source_text(req)
    raw = await llm.read_handover_minutes(source_text)
    if not raw:
        raise HTTPException(
            503,
            "Không đọc được biên bản: dịch vụ AI không phản hồi. Thử lại sau.",
        )
    parsed, warnings = handover_import.verify_parsed(raw, source_text)
    return {"parsed": parsed, "warnings": warnings, "source_text": source_text}


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

    Never merged automatically: FKs reach devices, handovers and user_devices, so a
    human rules on it. Checked whether or not the code in the minutes exists.
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


async def _plan_user(pool, party: dict, label: str, teams: list[str]) -> dict:
    """Reconcile one party against the ledger. Read-only."""
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

    current = await user_repo.get(pool, code)
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


def _plan_item(
    item: dict, *, user_code, it_code, other_code, devices: dict, histories: dict
) -> dict:
    """Reconcile one line item and decide its direction. Read-only.

    Takes the device and its history rather than fetching them, so a record's rows
    cost two queries between them instead of two each — see plan_handover.
    """
    serial = item["serial"]
    device = devices.get(serial)
    history = histories.get(serial, [])
    decision = handover_import.decide_flow(
        user_code=user_code,
        it_code=it_code,
        other_code=other_code,
        device=device,
        history=history,
    )
    proposed_device = {
        f: item.get("device", {}).get(f) for f in MINUTES_DEVICE_FIELDS
    }
    plan = {
        **decision,
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
                "payload": {"serial": serial, "fields": conflicts},
            })
        if fills or conflicts:
            plan["device_action"] = "update"

    if decision.get("duplicate_of"):
        plan["issues"].append({
            "kind": "handover_duplicate",
            "resource": "handovers",
            "item_id": serial,
            "payload": {
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
                "serial": serial,
                "reason": decision.get("flow_reason"),
                "guess": decision.get("flow"),
            },
        })
    return plan


@router.post("/handover/plan")
async def plan_handover(req: PlanRequest, pool=Depends(get_pool)):
    """What importing this record would do. Writes nothing."""
    parsed = req.parsed or {}
    party_a = parsed.get("party_a") or {}
    party_b = parsed.get("party_b") or {}
    user_a = await user_repo.get(pool, party_a["code"]) if party_a.get("code") else None
    user_b = await user_repo.get(pool, party_b["code"]) if party_b.get("code") else None

    if req.it_side in ("a", "b"):
        it_side, it_reason = req.it_side, "Bên IT do người dùng chọn."
    else:
        it_side, it_reason = handover_import.detect_it_side(
            party_a, party_b, user_a, user_b
        )

    it_code = (party_a if it_side == "a" else party_b).get("code") if it_side else None
    if it_side == "a":
        user_code, other_code = party_b.get("code"), None
    elif it_side == "b":
        user_code, other_code = party_a.get("code"), None
    else:
        user_code, other_code = party_a.get("code"), party_b.get("code")

    teams = await user_repo.list_teams(pool)
    users = [
        await _plan_user(pool, party_a, "Bên A", teams),
        await _plan_user(pool, party_b, "Bên B", teams),
    ]

    raw_items = parsed.get("items") or []
    serials = [i["serial"] for i in raw_items if i.get("serial")]
    devices = await device_repo.get_many(pool, serials)
    histories = await handover_repo.list_by_devices(pool, serials)
    items = [
        _plan_item(
            {**raw, "_date": parsed.get("handover_date")},
            user_code=user_code,
            it_code=it_code,
            other_code=other_code,
            devices=devices,
            histories=histories,
        )
        for raw in raw_items
    ]

    return {
        "source_file": req.source_file,
        "handover_date": parsed.get("handover_date"),
        "place": parsed.get("place"),
        "it_side": it_side,
        "it_reason": it_reason,
        "it_code": it_code,
        "user_code": user_code,
        "users": users,
        "items": items,
        "issue_count": sum(len(u["issues"]) for u in users)
        + sum(len(i["issues"]) for i in items),
    }


# ---------------------------------------------------------------------- apply

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
                current = await device_repo.get(conn, item.serial)
                if current is None:
                    if not item.create_device:
                        raise HTTPException(
                            409,
                            f"Thiết bị {item.serial} chưa có trong hệ thống. "
                            "Bật tạo mới hoặc bỏ qua dòng này.",
                        )
                    try:
                        await device_repo.create(conn, DeviceCreate(
                            serial_number=item.serial, status="in_stock",
                            user_id=GHOST_CODE, **fields,
                        ))
                    except (DuplicateError, ForeignKeyError) as e:
                        raise HTTPException(409, str(e))
                    result.devices_created += 1
                elif fields:
                    await device_repo.update(conn, item.serial, DeviceUpdate(**fields))
                    result.devices_updated += 1

                after = handover_import.apply_flow(
                    item.flow,
                    user_code=req.party_b_code if req.it_side == "a" else req.party_a_code,
                    it_code=req.party_a_code if req.it_side == "a" else req.party_b_code,
                    device=await device_repo.get(conn, item.serial),
                )
                if item.flow == TRANSFER:
                    after = {
                        "from_user_id": req.party_a_code,
                        "to_user_id": req.party_b_code,
                        "device_owner_after": req.party_b_code,
                        "device_status_after": "active",
                    }

                try:
                    await handover_repo.create(conn, HandoverCreate(
                        handover_id=item.handover_id or str(uuid.uuid4()),
                        handover_date=item.handover_date or req.handover_date,
                        device_id=item.serial,
                        from_user_id=after["from_user_id"],
                        to_user_id=after["to_user_id"],
                        reason=(item.reason or _default_reason(item.flow))[:100],
                    ))
                except (DuplicateError, ForeignKeyError) as e:
                    raise HTTPException(409, str(e))
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


async def _still_stands(pool, issue: dict) -> tuple[bool, str | None]:
    """Is this open issue still true of the ledger? Returns (stands, why-not).

    The backlog goes stale on its own: someone fills the missing specs from the
    Devices screen, or corrects a team on the person's own row, and the issue that
    asked for exactly that is still sitting there. Rather than trust every editing
    path to remember to close it, the truth is re-derived from the data.
    """
    kind, item_id = issue["kind"], issue.get("item_id")
    payload = issue.get("payload") or {}
    if not item_id:
        return True, None  # nothing to check it against — a human still rules

    if issue["resource"] == "users":
        current = await user_repo.get(pool, item_id)
    elif issue["resource"] == "devices":
        current = await device_repo.get(pool, item_id)
    else:
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
    closed = 0
    for issue in await issues_repo.list_issues(pool, status=issues_repo.OPEN, limit=500):
        stands, why = await _still_stands(pool, issue)
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
