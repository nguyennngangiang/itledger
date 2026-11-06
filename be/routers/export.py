"""GLPI export — download one of the three importer files over HTTP.

The CLI (`python -m be.export_glpi`) stays the main path: it writes all three
files at once, in the order GLPI needs them, and prints the warnings. This
endpoint is for the case where nobody can get a shell on the box — one file per
call, same bytes.

This app has no login (see the note in main.py), so anyone who can reach the
API can pull these files. That is the same reach they already have over the
ledger itself — the export adds no exposure of its own.

    GET /export/glpi?kind=devices
    GET /export/glpi?kind=handovers&since=2026-01-01

Warnings are not silently dropped — they come back in the `X-Export-Warnings`
header as a count, with the detail in `X-Export-Warning-1..5`. A header cannot
carry a newline, so anything longer is a reason to use the CLI, and the response
says so.
"""
import hmac
import json
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response

from ..config import settings
from ..db import get_pool
from ..export_glpi import (
    DEVICE_HEADER,
    HANDOVER_HEADER,
    MAINTENANCE_HEADER,
    Warnings,
    codes_in,
    device_rows,
    flag_risky_codes,
    handover_rows,
    maintenance_rows,
    to_csv,
)
from ..repositories import export as repo

router = APIRouter(prefix="/export", tags=["export"])

KINDS = {
    "devices": (DEVICE_HEADER, device_rows),
    "handovers": (HANDOVER_HEADER, handover_rows),
    "maintenance": (MAINTENANCE_HEADER, maintenance_rows),
}

# Headers are latin-1 on the wire; a Vietnamese sample value in a warning would
# raise on send. Warnings are ASCII-folded rather than dropped.
_MAX_HEADER_WARNINGS = 5


def _ascii(text: str) -> str:
    return text.encode("ascii", "replace").decode("ascii")[:180]


@router.get("/glpi")
async def export_glpi(
    kind: str = Query(..., description="devices | handovers | maintenance"),
    since: str | None = Query(
        None,
        description="YYYY-MM-DD. Filters handovers and maintenance only — devices "
                    "are always full, the ledger has no updated_at to delta on.",
    ),
    pool=Depends(get_pool),
):
    if kind not in KINDS:
        raise HTTPException(422, f"kind phải là một trong: {', '.join(KINDS)}.")

    cutoff: date | None = None
    if since:
        try:
            cutoff = date.fromisoformat(since)
        except ValueError:
            raise HTTPException(422, "since phải có dạng YYYY-MM-DD.")

    header, build_rows = KINDS[kind]
    warn = Warnings()
    if kind == "devices":
        records = await repo.devices(pool)
    elif kind == "handovers":
        records = await repo.handovers(pool, cutoff)
    else:
        records = await repo.maintenance(pool, cutoff)

    rows = build_rows(records, warn)
    await flag_risky_codes(pool, codes_in({kind: (None, header, rows)}), warn)

    # utf-8-sig so Excel opens Vietnamese text intact — same bytes as the CLI.
    body = to_csv(header, rows).encode("utf-8-sig")
    stamp = date.today().strftime("%Y%m%d")
    out = {
        "content-disposition": f'attachment; filename="itledger_{kind}_{stamp}.csv"',
        "x-export-rows": str(len(rows)),
        "x-export-read": str(len(records)),
        "x-export-warnings": str(sum(1 for _ in warn.lines())),
    }
    for i, line in enumerate(warn.lines()[:_MAX_HEADER_WARNINGS], start=1):
        out[f"x-export-warning-{i}"] = _ascii(line.strip())
    if len(warn.lines()) > _MAX_HEADER_WARNINGS:
        out["x-export-warnings-truncated"] = "run python -m be.export_glpi for the full list"

    return Response(content=body, media_type="text/csv; charset=utf-8", headers=out)


# --- cổng di cư TẠM THỜI ---------------------------------------------------

def _export_open() -> str | None:
    """Lý do cổng đang ĐÓNG, hoặc None nếu mở.

    Fail-closed ở cả ba nhánh. Cổng này nằm trên Internet, app đã bỏ đăng nhập,
    và thứ nó phục vụ là họ tên cùng mã của 258 nhân sự — nên "chưa cấu hình"
    phải có nghĩa là đóng, không bao giờ có nghĩa là mở.
    """
    if not settings.export_token:
        return "EXPORT_TOKEN chưa đặt"
    if len(settings.export_token) < 32:
        return "EXPORT_TOKEN quá ngắn (cần >= 32 ký tự)"
    if not settings.export_token_until:
        return "EXPORT_TOKEN_UNTIL chưa đặt"
    try:
        han = date.fromisoformat(settings.export_token_until)
    except ValueError:
        return "EXPORT_TOKEN_UNTIL không phải YYYY-MM-DD"
    if date.today() > han:
        return f"cổng đã hết hạn ngày {han.isoformat()}"
    return None


def require_export_token(authorization: str | None = Header(default=None)) -> None:
    """Khoá RIÊNG của cổng này, không dùng chung với bất cứ thứ gì của app.

    Trả 404 chứ không 401 khi cổng đóng hoặc sai khoá: một con đường chỉ sống
    vài ngày thì không nên tự quảng cáo sự tồn tại của mình cho người dò.
    """
    if _export_open() is not None:
        raise HTTPException(404, "Not Found")
    token = (authorization or "").removeprefix("Bearer ").strip()
    # compare_digest: so sánh không phụ thuộc thời gian, để không rò rỉ từng
    # ký tự của khoá qua việc đo độ trễ.
    if not token or not hmac.compare_digest(token, settings.export_token):
        raise HTTPException(404, "Not Found")


def _json_safe(value):
    """Kiểu của asyncpg -> kiểu JSON hiểu được, không mất mát.

    Ngày giờ ra ISO-8601 có múi giờ; Decimal ra CHUỖI chứ không phải float —
    tiền và số lượng đi qua float là mất chính xác, và bên nhận parse chuỗi
    thành Decimal dễ hơn là đoán xem con số đã bị làm tròn chưa.
    """
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, memoryview):
        return value.tobytes().hex()
    return value


@router.get("/data", dependencies=[Depends(require_export_token)])
async def export_data(pool=Depends(get_pool)):
    """Toàn bộ sổ, một lần gọi, cho hệ thống mới tự kéo sang.

        curl -H "Authorization: Bearer $EXPORT_TOKEN" https://<host>/api/export/data

    Gồm cả hàng đã xoá mềm (`deleted_at` khác NULL) — bỏ thùng rác lại là làm
    mất lịch sử nhà mới có thể cần khôi phục. Kèm `counts` đếm thật để bên nhận
    đối chiếu, và `tables` theo thứ tự nạp được: users trước devices, devices
    trước handovers/maintenance, vì khoá ngoại.
    """
    data, counts = {}, await repo.table_counts(pool)
    for t in repo.MIGRATE_TABLES:
        rows = await repo.table_rows(pool, t)
        data[t] = [{k: _json_safe(v) for k, v in dict(r).items()} for r in rows]
        if len(data[t]) != counts[t]:
            # Hai truy vấn, hai thời điểm. Lệch nghĩa là có người đang sửa sổ
            # giữa chừng, và một bản sao chụp lúc đó thì không đáng tin.
            raise HTTPException(
                503, f"bảng {t} đổi giữa chừng ({counts[t]} -> {len(data[t])}), chạy lại")
    body = {
        "version": 1,
        "taken_at": datetime.now(timezone.utc).isoformat(),
        "order": list(repo.MIGRATE_TABLES),
        "counts": counts,
        "tables": data,
    }
    return Response(
        content=json.dumps(body, ensure_ascii=False, indent=1),
        media_type="application/json; charset=utf-8",
        headers={"cache-control": "no-store",
                 "content-disposition": 'attachment; filename="itledger-export.json"'},
    )


@router.get("/data/status")
async def export_status():
    """Cổng có mở không, và tới bao giờ. KHÔNG cần khoá, và cố ý như vậy:
    bên kia cần biết đường này còn sống trước khi cầm khoá đi gọi."""
    ly_do = _export_open()
    return {"open": ly_do is None,
            "until": settings.export_token_until or None,
            "reason": ly_do}
