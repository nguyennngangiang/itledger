"""Devices REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/device.py.
"""
from datetime import date

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..db import get_pool
from ..glossary import bilingualize
from ..models.device import DeviceCreate, DeviceOut, DeviceUpdate, DeviceDelete
from ..repositories import device as repo
from ..repositories import maintenance as maint_repo
from ..repositories import user as user_repo
from ..repositories.errors import DuplicateError, ForeignKeyError

router = APIRouter(prefix="/devices", tags=["devices"])


class DevicePage(BaseModel):
    rows: list[DeviceOut]
    total: int


class ImportResult(BaseModel):
    inserted: int
    skipped: int
    total: int


class DeviceRanked(DeviceOut):
    """A device plus its semantic-similarity score (0–1) and the exact sentence
    the embedder ranked it on (`document`)."""
    score: float
    document: str


def _age_phrase(buy_date) -> str | None:
    """Describe the device's age so queries like 'old' / 'aging' have signal."""
    if not buy_date:
        return None
    years = (date.today() - buy_date).days / 365.25
    label = f"purchased {buy_date.year}, about {round(years)} years old"
    if years >= 5:
        label += ", aging old hardware"
    return label


def _repair_phrase(repairs: int) -> str:
    """Describe repair history in words that also match 'broken' / 'malfunction'."""
    if not repairs:
        return "never repaired, no malfunctions"
    label = f"repaired {repairs} times, has broken down and malfunctioned"
    if repairs >= 3:
        label += ", frequently breaking, unreliable"
    return label


def _status_phrase(status: str | None) -> str | None:
    if not status:
        return None
    if status == "maintaining":
        return "status maintaining, currently broken and under repair"
    return f"status {status}"


def _device_document(device: dict, repairs: int, team: str | None) -> str:
    """Flatten a device into a short natural-language line for embedding.

    This is also returned to the UI as the match's *proof* — the exact text the
    embedder read — so it stays human-readable on purpose.
    """
    ram = device.get("ram")
    parts = [
        device.get("name") or device["serial_number"],
        device.get("type"),
        device.get("brand"),
        device.get("cpu"),
        f"{ram} RAM" if ram else None,
        device.get("storage"),
        device.get("os"),
        device.get("msoffice"),
        _status_phrase(device.get("status")),
        f"owned by {team} team" if team else "unassigned, in stock",
        _repair_phrase(repairs),
        _age_phrase(device.get("buy_date")),
    ]
    return bilingualize(", ".join(p for p in parts if p))


@router.post("", response_model=DeviceOut, status_code=201)
async def create_device(device: DeviceCreate, pool=Depends(get_pool)):
    try:
        return await repo.create(pool, device)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))

@router.post("/batch", response_model=list[DeviceOut], status_code=201)
async def create_device_batch(devices: list[DeviceCreate], pool=Depends(get_pool)):
    try:
        return await repo.create_batch(pool, devices)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))


@router.post("/import", response_model=ImportResult)
async def import_devices(devices: list[DeviceCreate], pool=Depends(get_pool)):
    """Bulk import from an uploaded xlsx/csv. Skips serials that already exist."""
    try:
        return await repo.import_devices(pool, devices)
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))


@router.get("", response_model=list[DeviceOut])
async def list_devices(user_id: str | None = None, pool=Depends(get_pool)):
    return await repo.list_devices(pool, user_id)

@router.get("/page", response_model=DevicePage)
async def page_devices(
    limit: int = 20,
    offset: int = 0,
    order_by: str = "serial_number",
    order: str = "asc",
    deleted: bool = False,
    q: str | None = None,
    status: str | None = None,
    pool=Depends(get_pool),
):
    rows, total = await repo.list_page(
        pool,
        limit=limit,
        offset=offset,
        order_by=order_by,
        order=order,
        deleted=deleted,
        q=q,
        status=status,
    )
    return {"rows": rows, "total": total}


@router.get("/search", response_model=list[DeviceOut])
async def search_devices(q: str, pool=Depends(get_pool)):
    return await repo.search(pool, q)

@router.get("/filter", response_model=list[DeviceOut])
async def filter_devices(field: str, value: str, pool=Depends(get_pool)):
    return await repo.filter_devices(pool, field, value)


@router.get("/semantic-search", response_model=list[DeviceRanked])
async def semantic_search(
    q: str, limit: int = 20, pool=Depends(get_pool)
):
    """Rank active devices by how well they match a natural-language query,
    using the local embedding service. Declared before /{serial_number} so
    "semantic-search" isn't read as a serial number."""
    devices = await repo.list_devices(pool)
    if not devices:
        return []

    counts = await maint_repo.counts_by_device(pool)
    users = {u["employee_code"]: u for u in await user_repo.list_users(pool)}
    documents = [
        {
            "id": d["serial_number"],
            "text": _device_document(
                d,
                counts.get(d["serial_number"], 0),
                (users.get(d.get("user_id")) or {}).get("team"),
            ),
        }
        for d in devices
    ]
    text_by_id = {doc["id"]: doc["text"] for doc in documents}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.ai_url}/rank",
                json={"query": q, "documents": documents, "top_k": limit},
            )
            resp.raise_for_status()
            ranked = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(503, f"AI search service unavailable: {e}")

    by_id = {d["serial_number"]: d for d in devices}
    results = [
        {
            **by_id[r["id"]],
            "score": round(r["score"], 4),
            "document": text_by_id[r["id"]],
        }
        for r in ranked
        if r["id"] in by_id
    ]

    return results

@router.get("/{serial_number}", response_model=DeviceOut)
async def get_device(serial_number: str, pool=Depends(get_pool)):
    device = await repo.get(pool, serial_number)
    if device is None:
        raise HTTPException(404, f"Device not found: {serial_number}")
    return device


@router.patch("/{serial_number}", response_model=DeviceOut)
async def update_device(
    serial_number: str, device: DeviceUpdate, pool=Depends(get_pool)
):
    try:
        updated = await repo.update(pool, serial_number, device)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))
    if updated is None:
        raise HTTPException(404, f"Device not found: {serial_number}")
    return updated


@router.post("/restore", response_model=DeviceOut)
async def restore_device(device: DeviceDelete, pool=Depends(get_pool)):
    if not await repo.restore(pool, device.serial_number):
        raise HTTPException(404, f"Device not found: {device.serial_number}")
    return await repo.get(pool, device.serial_number)


@router.delete("", status_code=204)
async def delete_device(
    device: DeviceDelete, permanent: bool = False, pool=Depends(get_pool)
):
    action = repo.purge if permanent else repo.delete
    if not await action(pool, device.serial_number):
        raise HTTPException(404, f"Device not found: {device.serial_number}")

@router.delete("/batch", status_code=204)
async def delete_device_batch(
    serials: list[str], permanent: bool = False, pool=Depends(get_pool)
):
    """Bulk delete by serial number. Soft-delete by default; `permanent=true`
    purges from the trash. Missing serials are ignored (no 404)."""
    await repo.delete_many(pool, serials, permanent=permanent)



