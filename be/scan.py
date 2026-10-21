"""Reading supplier paperwork and device labels with Claude.

Every supplier hands over its own form — Hacom's "biên bản bàn giao" lists the
serials under the item name, its "phiếu xuất kho" gives one row per serial, FPT
and An Phát print yet other layouts, and almost every one is a scanned image with
no text layer. A template parser per supplier (the `handover_sheet.py` approach)
would need a new one for every shop the company buys from, so this asks a vision
model instead, and the parse is checked here rather than trusted.

Three things are decided in code, not by the model, because they must not drift:

  * **What is saved.** The model labels every line with a `kind`; only
    `device` lines become devices. Service stamps / warranty cards, promotion
    lines, bundled giveaways and loose PC parts are kept in the answer (so the
    review screen can show what was skipped and why) but never written.
  * **Grouping.** Lines with the same model are merged into one group whose
    serials are the union — Hacom's warehouse slip prints one row per laptop, the
    handover minutes print one row with three serials, and both should arrive as
    "this model, these serials".
  * **Learning.** Nothing is fine-tuned. Each time someone corrects a reading
    and saves it, the before/after pair is stored (repositories/scan.py) and the
    most recent ones are put in front of the next read as worked examples.

The call goes through `claude -p` on the HOST, not the API: the container talks
to deploy/vps/claude-runner.py over a unix socket, and that runs the Claude Code
CLI under the host's logged-in Claude account. No API key is involved. If the
runner is not there, `read()` raises 503 saying so.
"""
import base64
import json
import re
from typing import Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field

from .config import settings

Kind = Literal["device", "service_stamp", "promotion", "giveaway", "pc_part", "other"]
DeviceType = Literal["LAPTOP", "DESKTOP", "MONITOR", "TABLET", "PHONE", "PRINTER", "ACCESSORY", "OTHER"]

# Shown on the review screen next to a line that will not be saved.
SKIP_REASONS: dict[str, str] = {
    "service_stamp": "Tem / thẻ bảo hành dịch vụ",
    "promotion": "Dòng khuyến mại / ưu đãi",
    "giveaway": "Quà tặng kèm",
    "pc_part": "Linh kiện PC lẻ",
    "other": "Không phải thiết bị",
}

# What the model returns. Field descriptions double as instructions — the schema
# is the part of the prompt the model cannot ignore.


class ReadLine(BaseModel):
    kind: Kind = Field(description="device = a whole device the company will track. service_stamp = tem dịch vụ / tem kiểm định / thẻ bảo hành dịch vụ. promotion = discount/voucher lines (giảm giá, tặng mã ưu đãi, 0đ promo rows). giveaway = items given free with a purchase (balo khuyến mại, bàn di chuột 0 tháng BH). pc_part = loose desktop components (CPU, mainboard, RAM, SSD, PSU, case, cooler). other = anything else.")
    model_name: str = Field(description="Product name exactly as printed, without the serials.")
    short_name: str = Field(description="Short display name: brand + series + model code, e.g. 'Asus VivoBook E1504FA-BQ340W', 'LG 24U411A-B 24\"'. Max 60 chars.")
    type: DeviceType
    brand: str = Field(description="Manufacturer in upper case, e.g. ASUS, LG, HP, DELL, XIAOMI, LOGITECH. Empty if unknown.")
    cpu: str = Field(description="CPU as printed, e.g. 'Core Ultra 7 255H', 'Ryzen 5 7430U'. Empty if not stated.")
    ram: str = Field(description="e.g. '16GB'. Empty if not stated.")
    storage: str = Field(description="e.g. '512GB SSD'. Empty if not stated.")
    os: str = Field(description="e.g. 'Windows 11'. Empty if not stated.")
    serials: list[str] = Field(description="Every serial number printed for this line, one entry each, exactly as printed. Empty list if none.")
    quantity: int = Field(description="Quantity column, or the number of serials if there is no quantity column.")
    warranty_months: int = Field(description="Warranty in months for the device itself (0 if none / not stated).")
    unsure: list[str] = Field(description="Serials or fields you could not read with confidence (blurred, cut off, ambiguous 0/O, 1/I, 5/S, 8/B). Empty if all clear.")


class ReadAnswer(BaseModel):
    vendor: str = Field(description="Seller's short name as it appears on the form, e.g. 'HACOM', 'FPT Shop', 'An Phát'. Empty for a bare device label.")
    doc_type: str = Field(description="Form title, e.g. 'Biên bản bàn giao thiết bị', 'Phiếu xuất kho kiêm phiếu bảo hành', 'Phiếu giao hàng', or 'Tem thiết bị' for a device label photo.")
    doc_number: str = Field(description="Document / invoice / slip number if printed, else empty.")
    doc_date: str = Field(description="Document date as YYYY-MM-DD, empty if none is legible. Vietnamese forms write day before month.")
    lines: list[ReadLine]


SYSTEM = """You read Vietnamese IT purchase paperwork for a company's hardware ledger: supplier handover minutes (biên bản bàn giao), warehouse slips (phiếu xuất kho), delivery notes (phiếu giao hàng), warranty slips, and photos of serial-number labels on devices.

Return every item line on the document. Rules:
- Read serials character by character. Never invent, complete or "fix" a serial; if a character is unreadable, keep your best reading and list that serial in `unsure`.
- A serial can be printed under the product name (often after "SN:"), in its own column, or as several lines in one cell — each one is a separate entry in `serials`.
- Ignore the buyer's and seller's addresses, phone numbers, tax codes, signatures and stamps.
- "Mã hàng" / "Mã số" columns hold the shop's own SKU, not the serial.
- For a photo of a device label (not a form): one line, the device's model/serial (S/N), and leave vendor empty.
- A multi-page document is one document: lines continue across pages."""


class ScanUnavailable(HTTPException):
    def __init__(self, detail: str):
        super().__init__(status_code=503, detail=detail)


def _runner() -> httpx.AsyncClient:
    transport = httpx.AsyncHTTPTransport(uds=settings.claude_runner_socket)
    # The runner gives up at 280s; this waits a little longer so its own,
    # clearer timeout message is the one that arrives.
    return httpx.AsyncClient(transport=transport, base_url="http://runner", timeout=300)


async def runner_ready() -> bool:
    try:
        async with _runner() as c:
            r = await c.get("/health", timeout=20)
        return bool(r.json().get("ok"))
    except (httpx.HTTPError, ValueError):
        return False


def _content_block(data: bytes, mime: str) -> dict:
    b64 = base64.standard_b64encode(data).decode("ascii")
    if mime == "application/pdf":
        return {"type": "document", "source": {"type": "base64", "media_type": mime, "data": b64}}
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        raise HTTPException(status_code=415, detail=f"Không đọc được loại tệp {mime or 'không rõ'}.")
    return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}


def _examples_text(examples: list[dict]) -> str:
    """Past corrections as worked examples. Only what was CHANGED is shown —
    a whole before/after document per example would crowd out the page being read."""
    if not examples:
        return ""
    parts = []
    for ex in examples:
        notes = ex.get("notes") or []
        if not notes:
            continue
        head = f"- {ex.get('vendor') or 'nhãn thiết bị'} ({ex.get('doc_type') or '?'}):"
        parts.append(head + "\n" + "\n".join(f"    • {n}" for n in notes))
    if not parts:
        return ""
    return (
        "Earlier readings that a person corrected. Apply the same lessons when the "
        "document comes from the same supplier or has the same layout:\n" + "\n".join(parts)
    )


async def _ask(system: str, content: list[dict], answer: type[BaseModel], effort: str) -> BaseModel:
    """One `claude -p` run through the host runner, validated against `answer`."""
    body = {
        "system": system,
        "content": content,
        "schema": answer.model_json_schema(),
        "model": settings.scan_model,
        "effort": effort,
    }
    try:
        async with _runner() as c:
            r = await c.post("/run", json=body)
    except httpx.TransportError as e:
        raise ScanUnavailable(
            "Không gọi được claude -p trên máy chủ (dịch vụ itledger-claude-runner chưa chạy)."
        ) from e
    try:
        reply = r.json()
    except ValueError as e:
        raise ScanUnavailable(f"Dịch vụ claude -p trả lời lạ ({r.status_code}).") from e
    if not reply.get("ok"):
        status = r.status_code if r.status_code in (413, 422, 429, 503, 504) else 502
        raise HTTPException(status_code=status, detail=reply.get("error") or "Claude không đọc được tệp này.")
    try:
        return answer.model_validate(reply["output"])
    except ValueError as e:
        raise HTTPException(status_code=502, detail="Claude trả kết quả không đúng mẫu, thử đọc lại.") from e


async def read(data: bytes, mime: str, *, mode: str, examples: list[dict]) -> ReadAnswer:
    task = (
        "This is a photo of a device's label taken with a phone camera. Read the model and serial number."
        if mode == "label"
        else "Read this document and return its item lines."
    )
    lessons = _examples_text(examples)
    content = [_content_block(data, mime), {"type": "text", "text": task}]
    if lessons:
        content.append({"type": "text", "text": lessons})
    # Reading serials off a scan is careful work but not deep reasoning; low
    # effort keeps a camera read to a few seconds.
    return await _ask(SYSTEM, content, ReadAnswer, "low" if mode == "label" else "medium")


# ---------------------------------------------------------------- minutes

class MinutesParty(BaseModel):
    label: str = Field(description="'A' or 'B' (or 'C'… if more), as the form labels the side. Bên giao / bên bán / bên A first.")
    role: Literal["giver", "receiver", "buyer", "seller", "unknown"] = Field(description="giver/receiver for an internal handover (bên giao / bên nhận); buyer/seller for a supplier document (bên mua / bên bán).")
    name: str = Field(description="The person's full name exactly as printed, WITH Vietnamese diacritics. Empty if none.")
    code: str = Field(description="Employee code (mã NV / mã nhân viên / code), e.g. 'VPHN216'. Empty if none — supplier documents have none.")
    dept: str = Field(description="Department / bộ phận / phòng ban. Empty if none.")
    position: str = Field(description="Job title / chức vụ. Empty if none.")
    company: str = Field(description="Company name for this side (CÔNG TY …), with diacritics. Empty if not printed.")
    address: str = Field(description="Address printed for this side. Empty if none.")
    phone: str = Field(description="Phone number printed for this side. Empty if none.")


class MinutesItem(BaseModel):
    no: str = Field(description="Row number (STT / TT) as printed.")
    item: str = Field(description="Item name exactly as printed (tên hàng / nội dung), without the serials, with diacritics.")
    detail: str = Field(description="Configuration / detail column if separate, else the spec part of the name. Empty if none.")
    serials: list[str] = Field(description="Every serial number printed for this row, one entry each, exactly as printed.")
    quantity: int
    note: str = Field(description="Note / tình trạng / ghi chú column. Empty if none.")
    kind: Kind = Field(description="Same meaning as for item lines: device, service_stamp, promotion, giveaway, pc_part, other.")
    type: DeviceType
    brand: str = Field(description="Manufacturer in upper case. Empty if unknown.")
    cpu: str
    ram: str
    storage: str
    os: str
    unsure: list[str] = Field(description="Serials or names you could not read with confidence.")


class MinutesAnswer(BaseModel):
    kind: Literal["internal", "supplier"] = Field(description="internal = a handover between the company's IT and its employees (employee codes, bên giao / bên nhận are people of the same company). supplier = a seller's document (bên bán is a shop / distributor, bên mua the company).")
    doc_type: str = Field(description="Form title as printed.")
    doc_number: str = Field(description="Document number if printed, else empty.")
    handover_date: str = Field(description="Date as YYYY-MM-DD, empty if not legible. Day comes before month on Vietnamese forms.")
    place: str = Field(description="Place (địa điểm / tại …) if printed, else empty.")
    reason: str = Field(description="Reason / lý do / nội dung of the handover if printed, else empty.")
    parties: list[MinutesParty]
    items: list[MinutesItem]


MINUTES_SYSTEM = """You read paper handover records (biên bản bàn giao) photographed with a phone, page by page, for a company's IT hardware ledger. Two kinds exist:
- INTERNAL: the company's IT department hands devices to, or takes them back from, an employee. Each side is a person with an employee code (mã NV), department, position.
- SUPPLIER: a shop or distributor (Hacom, FPT, An Phát…) hands purchased goods to the company. Sides are companies (bên bán / bên mua).

Several photos may show different parts of the SAME document, overlapping: merge them into one record, never duplicate a row or a party seen twice.
A PDF may hold several pages, or several slips from the same supplier one after another (e.g. a handover record plus a warehouse slip): return EVERY item row from EVERY page — never stop at the first document.
Rules:
- Text can be in any language. Copy names, departments and item names exactly as printed, keeping every diacritic.
- Read serials character by character; never invent or complete one. List doubtful ones in `unsure`.
- A serial can be printed under the item name (after "SN:"), in its own column, or several in one cell.
- Ignore signatures and stamps."""


async def read_minutes(blocks: list[tuple[bytes, str]], examples: list[dict]) -> MinutesAnswer:
    content = [_content_block(data, mime) for data, mime in blocks]
    content.append({"type": "text", "text": f"These {len(blocks)} image(s)/file(s) are one handover record. Return it."})
    lessons = _examples_text(examples)
    if lessons:
        content.append({"type": "text", "text": lessons})
    return await _ask(MINUTES_SYSTEM, content, MinutesAnswer, "medium")


def minutes_parsed(answer: MinutesAnswer) -> dict:
    """The internal record in the shape /imports/handover/plan takes (the
    `parsed` of be/handover_import.py), so the existing plan/apply screen runs
    on it unchanged. One item per serial: the plan resolves devices by serial."""
    items = []
    row = 0
    for it in answer.items:
        if it.kind != "device":
            continue
        serials = [c for c in (clean_serial(s) for s in it.serials) if c] or [""]
        for s in serials:
            row += 1
            items.append({
                "row": row, "no": it.no, "quantity": 1, "item": it.item, "detail": it.detail,
                "serial": s, "note": it.note,
                "device": {"type": it.type, "brand": it.brand.upper(), "cpu": it.cpu, "ram": it.ram,
                           "storage": it.storage, "name": it.item[:100]},
            })
    return {
        "handover_date": answer.handover_date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", answer.handover_date) else None,
        "place": answer.place,
        "parties": [
            {"label": p.label, "name": p.name, "code": p.code.strip().upper(), "dept": p.dept, "position": p.position}
            for p in answer.parties
        ],
        "items": items,
    }


def minutes_as_reading(answer: MinutesAnswer) -> ReadAnswer:
    """A supplier record, as the item-line reading the supplier review list
    (`group()`) already understands."""
    seller = next((p for p in answer.parties if p.role == "seller"), None)
    return ReadAnswer(
        vendor=(seller.company or seller.name) if seller else "",
        doc_type=answer.doc_type,
        doc_number=answer.doc_number,
        doc_date=answer.handover_date,
        lines=[
            ReadLine(kind=it.kind, model_name=it.item, short_name=it.item[:60], type=it.type, brand=it.brand,
                     cpu=it.cpu, ram=it.ram, storage=it.storage, os=it.os, serials=it.serials,
                     quantity=it.quantity, warranty_months=0, unsure=it.unsure)
            for it in answer.items
        ],
    )


# ---------------------------------------------------------------- post-process

# Only a LABEL is stripped — "SN:", "S/N ", "Serial No." — never the letters
# themselves: real serials start with SN too (An Phát's "SN242550042406").
_SERIAL_JUNK = re.compile(r"^(S/?N|SERIAL(\s*NO\.?)?|SỐ SERI)(\s*[:#.]\s*|\s+)", re.IGNORECASE)


def clean_serial(s: str) -> str:
    """Strip the label a serial is often printed with and any spacing. Case is
    kept: some vendors' serials are case-sensitive in their portals."""
    s = _SERIAL_JUNK.sub("", s.strip())
    return re.sub(r"\s+", "", s)


def _group_key(line: ReadLine) -> str:
    name = (line.short_name or line.model_name).upper()
    return re.sub(r"[^A-Z0-9]", "", name)


def group(answer: ReadAnswer) -> dict:
    """Merge same-model lines, split device lines from skipped ones, and flag
    serials that appear twice in one document."""
    groups: dict[str, dict] = {}
    skipped: list[dict] = []
    seen: dict[str, int] = {}

    for line in answer.lines:
        serials = [c for c in (clean_serial(s) for s in line.serials) if c]
        fields = {
            "name": (line.short_name or line.model_name)[:100],
            "model_name": line.model_name,
            "type": line.type,
            "brand": line.brand.upper()[:100],
            "cpu": line.cpu[:100],
            "ram": line.ram[:100],
            "storage": line.storage[:100],
            "os": line.os[:100],
            "warranty_months": line.warranty_months,
        }
        if line.kind != "device":
            # Kept whole so the review screen can put a line back if the model
            # sorted it wrongly (a mouse with 24 months' warranty is a device).
            skipped.append({
                **fields,
                "kind": line.kind,
                "reason": SKIP_REASONS.get(line.kind, SKIP_REASONS["other"]),
                "serials": serials,
                "quantity": max(line.quantity, len(serials), 1),
            })
            continue
        for s in serials:
            seen[s] = seen.get(s, 0) + 1
        key = _group_key(line)
        g = groups.get(key)
        if g is None:
            g = groups[key] = {**fields, "serials": [], "unsure": [], "quantity": 0}
        g["quantity"] += max(line.quantity, len(serials))
        for s in serials:
            if s not in g["serials"]:
                g["serials"].append(s)
        g["unsure"] += [clean_serial(u) for u in line.unsure if clean_serial(u) in serials]

    items = list(groups.values())
    for g in items:
        # Quantity says three, two serials were printed: the review screen has to
        # show that a serial is missing, not quietly save two devices.
        g["missing"] = max(g["quantity"] - len(g["serials"]), 0)
    return {
        "vendor": answer.vendor,
        "doc_type": answer.doc_type,
        "doc_number": answer.doc_number,
        "doc_date": answer.doc_date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", answer.doc_date) else "",
        "items": items,
        "skipped": skipped,
        "duplicates": sorted(s for s, n in seen.items() if n > 1),
    }


# ---------------------------------------------------------------- learning

_FIELDS = ("name", "type", "brand", "cpu", "ram", "storage", "os")


def correction_notes(original: dict, final: list[dict]) -> list[str]:
    """Plain-language list of what the person changed between what Claude read
    (`original`, the `group()` output) and what they saved. Empty when the
    reading was accepted as-is — nothing worth teaching."""
    notes: list[str] = []
    orig_items = original.get("items") or []
    orig_serials = {s: g for g in orig_items for s in g.get("serials", [])}
    final_serials = {s: g for g in final for s in g.get("serials", [])}

    for g in final:
        # Match a saved group to the read group it came from by shared serials.
        src = next((orig_serials[s] for s in g.get("serials", []) if s in orig_serials), None)
        if src is None:
            continue
        for f in _FIELDS:
            a, b = (src.get(f) or "").strip(), (g.get(f) or "").strip()
            if a != b and b:
                notes.append(f"{f} của '{src.get('model_name') or src.get('name')}': đọc '{a}' → đúng là '{b}'")

    removed = [s for s in orig_serials if s not in final_serials]
    added = [s for s in final_serials if s not in orig_serials]
    # A removed + an added serial of equal length is almost always a misread.
    for a in list(removed):
        twin = next((b for b in added if len(b) == len(a)), None)
        if twin:
            notes.append(f"serial đọc '{a}' → đúng là '{twin}'")
            removed.remove(a)
            added.remove(twin)
    for s in removed:
        notes.append(f"'{s}' không phải serial thiết bị, không lấy")
    for s in added:
        notes.append(f"bỏ sót serial '{s}'")
    return notes[:20]


def party_notes(original: list[dict], final: list[dict]) -> list[str]:
    """What a person changed on the sides of a record (name, code, dept…)."""
    notes = []
    by_label = {p.get("label"): p for p in original}
    for p in final:
        o = by_label.get(p.get("label"))
        if not o:
            continue
        for f in ("name", "code", "dept", "position", "company"):
            a, b = (o.get(f) or "").strip(), (p.get(f) or "").strip()
            if b and a != b:
                notes.append(f"Bên {p.get('label')} — {f}: đọc '{a}' → đúng là '{b}'")
    return notes[:10]


def notes_json(notes: list[str]) -> str:
    return json.dumps(notes, ensure_ascii=False)
