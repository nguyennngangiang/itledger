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
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

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
