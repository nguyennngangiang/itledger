"""Handovers REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/handover.py.
"""
import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..db import get_pool
from ..glossary import bilingualize
from ..models.handover import HandoverCreate, HandoverOut, HandoverUpdate
from ..repositories import handover as repo
from ..repositories import device as device_repo
from ..repositories import user as user_repo
from ..repositories.errors import DuplicateError, ForeignKeyError

router = APIRouter(prefix="/handovers", tags=["handovers"])


class HandoverPage(BaseModel):
    rows: list[HandoverOut]
    total: int


class HandoverRanked(HandoverOut):
    """A handover record plus its semantic-similarity score (0–1) and the exact
    sentence the embedder ranked it on (`document`)."""
    score: float
    document: str


def _who(user: dict, uid: str | None) -> str | None:
    if not uid:
        return None
    name = user.get("name") or uid
    team = user.get("team")
    return f"{name} ({team})" if team else name


def _handover_document(h: dict, devices: dict, users: dict) -> str:
    """Flatten a handover into a short natural-language line for embedding — the
    device, who gave and received it, the reason and date."""
    device = devices.get(h.get("device_id")) if h.get("device_id") else None
    date = h.get("handover_date")
    parts = [
        f"handover of {(device or {}).get('name') or h['device_id']}"
        if h.get("device_id")
        else "handover",
        f"from {_who(users.get(h.get('from_user_id')) or {}, h.get('from_user_id'))}"
        if h.get("from_user_id")
        else None,
        f"to {_who(users.get(h.get('to_user_id')) or {}, h.get('to_user_id'))}"
        if h.get("to_user_id")
        else None,
        f"reason: {h['reason']}" if h.get("reason") else None,
        f"on {date}" if date else None,
    ]
    return bilingualize(", ".join(p for p in parts if p))


@router.post("", response_model=HandoverOut, status_code=201)
async def create_handover(handover: HandoverCreate, pool=Depends(get_pool)):
    try:
        return await repo.create(pool, handover)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))


@router.delete("/batch", status_code=204)
async def delete_handover_batch(
    ids: list[str] = Body(...), permanent: bool = False, pool=Depends(get_pool)
):
    """Bulk delete by id. Soft-delete by default; `permanent=true` purges.
    Declared before /{handover_id} so "batch" isn't read as an id."""
    await repo.delete_many(pool, ids, permanent=permanent)


@router.get("", response_model=list[HandoverOut])
async def list_handovers(
    device_id: str | None = None,
    from_user_id: str | None = None,
    to_user_id: str | None = None,
    pool=Depends(get_pool),
):
    return await repo.list_handovers(pool, device_id, from_user_id, to_user_id)


@router.get("/page", response_model=HandoverPage)
async def page_handovers(
    limit: int = 20,
    offset: int = 0,
    order_by: str = "handover_date",
    order: str = "desc",
    deleted: bool = False,
    q: str | None = None,
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
    )
    return {"rows": rows, "total": total}


@router.get("/semantic-search", response_model=list[HandoverRanked])
async def semantic_search(q: str, limit: int = 20, pool=Depends(get_pool)):
    """Rank active handover records by how well they match a natural-language
    query, using the local embedding service. Declared before /{handover_id} so
    "semantic-search" isn't read as an id."""
    records = await repo.list_handovers(pool)
    if not records:
        return []

    devices = {d["serial_number"]: d for d in await device_repo.list_devices(pool)}
    users = {u["employee_code"]: u for u in await user_repo.list_users(pool)}
    documents = [
        {"id": h["handover_id"], "text": _handover_document(h, devices, users)}
        for h in records
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

    by_id = {h["handover_id"]: h for h in records}
    return [
        {
            **by_id[r["id"]],
            "score": round(r["score"], 4),
            "document": text_by_id[r["id"]],
        }
        for r in ranked
        if r["id"] in by_id
    ]


@router.post("/{handover_id}/restore", response_model=HandoverOut)
async def restore_handover(handover_id: str, pool=Depends(get_pool)):
    if not await repo.restore(pool, handover_id):
        raise HTTPException(404, f"Handover not found: {handover_id}")
    return await repo.get(pool, handover_id)


@router.get("/{handover_id}", response_model=HandoverOut)
async def get_handover(handover_id: str, pool=Depends(get_pool)):
    handover = await repo.get(pool, handover_id)
    if handover is None:
        raise HTTPException(404, f"Handover not found: {handover_id}")
    return handover


@router.patch("/{handover_id}", response_model=HandoverOut)
async def update_handover(
    handover_id: str,
    handover: HandoverUpdate,
    pool=Depends(get_pool),
):
    try:
        updated = await repo.update(pool, handover_id, handover)
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))
    if updated is None:
        raise HTTPException(404, f"Handover not found: {handover_id}")
    return updated


@router.delete("/{handover_id}", status_code=204)
async def delete_handover(
    handover_id: str, permanent: bool = False, pool=Depends(get_pool)
):
    action = repo.purge if permanent else repo.delete
    if not await action(pool, handover_id):
        raise HTTPException(404, f"Handover not found: {handover_id}")
