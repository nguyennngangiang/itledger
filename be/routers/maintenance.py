"""Maintenance REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/maintenance.py.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..db import get_pool
from ..models.maintenance import MaintenanceCreate, MaintenanceOut, MaintenanceUpdate
from ..repositories import maintenance as repo
from ..repositories.errors import DuplicateError, ForeignKeyError

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


@router.post("", response_model=MaintenanceOut, status_code=201)
async def create_maintenance(maintenance: MaintenanceCreate, pool=Depends(get_pool)):
    try:
        return await repo.create(pool, maintenance)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))


@router.get("", response_model=list[MaintenanceOut])
async def list_maintenance(
    device_id: str | None = None,
    team: str | None = None,
    pool=Depends(get_pool),
):
    return await repo.list_maintenance(pool, device_id, team)


@router.get("/{maintenance_id}", response_model=MaintenanceOut)
async def get_maintenance(maintenance_id: str, pool=Depends(get_pool)):
    maintenance = await repo.get(pool, maintenance_id)
    if maintenance is None:
        raise HTTPException(404, f"Maintenance not found: {maintenance_id}")
    return maintenance


@router.patch("/{maintenance_id}", response_model=MaintenanceOut)
async def update_maintenance(
    maintenance_id: str,
    maintenance: MaintenanceUpdate,
    pool=Depends(get_pool),
):
    try:
        updated = await repo.update(pool, maintenance_id, maintenance)
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))
    if updated is None:
        raise HTTPException(404, f"Maintenance not found: {maintenance_id}")
    return updated


@router.delete("/{maintenance_id}", status_code=204)
async def delete_maintenance(maintenance_id: str, pool=Depends(get_pool)):
    if not await repo.delete(pool, maintenance_id):
        raise HTTPException(404, f"Maintenance not found: {maintenance_id}")
