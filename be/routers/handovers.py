"""Handovers REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/handover.py.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..db import get_pool
from ..models.handover import HandoverCreate, HandoverOut, HandoverUpdate
from ..repositories import handover as repo
from ..repositories.errors import DuplicateError, ForeignKeyError

router = APIRouter(prefix="/handovers", tags=["handovers"])


@router.post("", response_model=HandoverOut, status_code=201)
async def create_handover(handover: HandoverCreate, pool=Depends(get_pool)):
    try:
        return await repo.create(pool, handover)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))


@router.get("", response_model=list[HandoverOut])
async def list_handovers(
    device_id: str | None = None,
    from_user_id: str | None = None,
    to_user_id: str | None = None,
    pool=Depends(get_pool),
):
    return await repo.list_handovers(pool, device_id, from_user_id, to_user_id)


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
async def delete_handover(handover_id: str, pool=Depends(get_pool)):
    if not await repo.delete(pool, handover_id):
        raise HTTPException(404, f"Handover not found: {handover_id}")
