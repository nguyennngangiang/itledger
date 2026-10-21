"""Scan screen: read paperwork or a device label with Claude, then save the
reviewed serials as devices.

  POST /scan/read   a PDF / image (a file, or one camera frame) -> grouped lines
  POST /scan/save   the reviewed groups -> new in-stock devices; a corrected
                    reading is kept as an example for the next read
  GET  /scan/status whether Claude is configured, and how many corrections
                    have been learned — the screen says so rather than letting
                    the first read fail

Barcodes are decoded in the browser and never come here; only text that needs
reading does.
"""
import base64
import binascii
import json
import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import scan
from ..config import settings
from ..constants import GHOST_CODE
from ..db import get_pool
from ..models.device import DeviceCreate
from ..repositories import device as device_repo
from ..repositories import scan as repo
from ..repositories import user as user_repo

router = APIRouter(prefix="/scan", tags=["scan"])
log = logging.getLogger("uvicorn.error")

# Same cap as the import endpoints. A phone camera frame is ~200 KB; a scanned
# six-page PDF ~3 MB.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


class ReadRequest(BaseModel):
    name: str = ""
    mime: str
    data: str  # base64 file bytes
    # "label" = one photo of a device's sticker; "document" = a form / invoice.
    mode: str = Field(default="document", pattern="^(document|label)$")


class SaveGroup(BaseModel):
    name: str = Field(max_length=100)
    type: str = Field(default="", max_length=100)
    brand: str = Field(default="", max_length=100)
    cpu: str = Field(default="", max_length=100)
    ram: str = Field(default="", max_length=100)
    storage: str = Field(default="", max_length=100)
    os: str = Field(default="", max_length=100)
    serials: list[str]


class SaveRequest(BaseModel):
    vendor: str = ""
    doc_type: str = ""
    buy_date: date | None = None
    groups: list[SaveGroup]
    # What /scan/read returned, untouched. Absent for a list built purely from
    # barcodes — there is no reading to learn from then.
    original: dict | None = None


@router.get("/status")
async def status(pool=Depends(get_pool)):
    return {
        "claude": await scan.runner_ready(),
        "model": settings.scan_model,
        "learned": await repo.count_examples(pool),
    }


@router.post("/read")
async def read(req: ReadRequest, pool=Depends(get_pool)):
    try:
        data = base64.b64decode(req.data.split(",", 1)[-1], validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(422, "Tệp gửi lên không đúng định dạng base64.") from e
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Tệp lớn hơn 20 MB.")
    mime = req.mime or ("application/pdf" if req.name.lower().endswith(".pdf") else "")
    examples = await repo.recent_examples(pool)
    answer = await scan.read(data, mime, mode=req.mode, examples=examples)
    if req.mode == "label":
        # One sticker photographed on purpose IS the device to add, whatever
        # kind Claude filed it under — a mouse's label must not land in "not
        # saved" just because mice often ship as giveaways.
        for line in answer.lines:
            if line.serials:
                line.kind = "device"
    result = scan.group(answer)
    every = [s for g in result["items"] for s in g["serials"]]
    result["existing"] = await repo.existing_serials(pool, every)
    return result


class Frame(BaseModel):
    mime: str
    data: str  # base64


class MinutesRequest(BaseModel):
    # Camera stills of one record (several overlapping parts of the page), or
    # one uploaded PDF/photo — the same list either way.
    frames: list[Frame] = Field(min_length=1, max_length=8)


def _decode(data: str) -> bytes:
    try:
        return base64.b64decode(data.split(",", 1)[-1], validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(422, "Tệp gửi lên không đúng định dạng base64.") from e


@router.post("/minutes/read")
async def read_minutes(req: MinutesRequest, pool=Depends(get_pool)):
    blocks = [(_decode(f.data), f.mime) for f in req.frames]
    if sum(len(b) for b, _ in blocks) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Ảnh/tệp lớn hơn 20 MB.")
    answer = await scan.read_minutes(blocks, await repo.recent_examples(pool))

    serials = [scan.clean_serial(s) for it in answer.items for s in it.serials]
    known: dict[str, dict] = {}
    for p in answer.parties:
        code = p.code.strip().upper()
        if code and (u := await user_repo.get(pool, code)):
            known[code] = {"name": u.get("name"), "team": u.get("team")}
    out = {
        "kind": answer.kind,
        "answer": answer.model_dump(),
        "existing": await repo.existing_serials(pool, [s for s in serials if s]),
        "known_codes": known,
    }
    if answer.kind == "internal":
        out["parsed"] = scan.minutes_parsed(answer)
    else:
        out["reading"] = scan.group(scan.minutes_as_reading(answer))
    return out


class LearnRequest(BaseModel):
    vendor: str = ""
    doc_type: str = ""
    original_items: list[dict] = []
    final_items: list[dict] = []
    original_parties: list[dict] = []
    final_parties: list[dict] = []


@router.post("/learn")
async def learn(req: LearnRequest, pool=Depends(get_pool)):
    """A minutes record was saved after a person corrected Claude's read: keep
    what changed as an example for the next read. Nothing changed → nothing kept."""
    notes = scan.party_notes(req.original_parties, req.final_parties)
    notes += scan.correction_notes({"items": req.original_items}, req.final_items)
    if notes:
        await repo.add_example(pool, req.vendor, req.doc_type, scan.notes_json(notes[:20]))
    return {"learned": bool(notes), "notes": len(notes)}


@router.post("/diag", status_code=204)
async def diag(report: dict):
    """A phone's scan tab was killed and reloaded (see fe/src/lib/scanHealth.ts):
    log what it was doing, so the cause can be read off `docker logs`. Nothing
    is stored; the report is capped so this cannot fill the log."""
    line = json.dumps(report, ensure_ascii=False)[:2000]
    log.warning("scan tab killed: %s", line)


@router.post("/save")
async def save(req: SaveRequest, pool=Depends(get_pool)):
    # Cleaned once, up front: the devices AND the learned corrections must see
    # the same serials, or a pasted "SN: X" reads as a serial Claude missed.
    for g in req.groups:
        g.serials = [c for c in (scan.clean_serial(s)[:100] for s in g.serials) if c]

    devices: list[DeviceCreate] = []
    seen: set[str] = set()
    for g in req.groups:
        for serial in g.serials:
            if serial in seen:
                continue
            seen.add(serial)
            devices.append(DeviceCreate(
                serial_number=serial,
                type=g.type or None,
                brand=g.brand or None,
                cpu=g.cpu or None,
                ram=g.ram or None,
                storage=g.storage or None,
                os=g.os or None,
                name=g.name or None,
                buy_date=req.buy_date,
                user_id=GHOST_CODE,
                status="in_stock",
            ))
    if not devices:
        raise HTTPException(422, "Không có serial nào để lưu.")

    existing = set(await repo.existing_serials(pool, [d.serial_number for d in devices]))
    result = await device_repo.import_devices(pool, devices)

    learned = False
    if req.original:
        notes = scan.correction_notes(req.original, [g.model_dump() for g in req.groups])
        if notes:
            await repo.add_example(pool, req.vendor, req.doc_type, scan.notes_json(notes))
            learned = True

    return {
        **result,
        "existing": sorted(existing),
        "learned": learned,
    }
