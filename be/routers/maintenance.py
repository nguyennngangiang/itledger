"""Maintenance REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/maintenance.py.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

from ..db import get_pool
from ..models.maintenance import MaintenanceCreate, MaintenanceOut, MaintenanceUpdate
from ..repositories import maintenance as repo
from ..repositories.errors import DuplicateError, ForeignKeyError

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


class MaintenancePage(BaseModel):
    rows: list[MaintenanceOut]
    total: int


@router.post("", response_model=MaintenanceOut, status_code=201)
async def create_maintenance(maintenance: MaintenanceCreate, pool=Depends(get_pool)):
    try:
        return await repo.create(pool, maintenance)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))


@router.delete("/batch", status_code=204)
async def delete_maintenance_batch(
    ids: list[str] = Body(...), permanent: bool = False, pool=Depends(get_pool)
):
    """Bulk delete by id. Soft-delete by default; `permanent=true` purges.
    Declared before /{maintenance_id} so "batch" isn't read as an id."""
    await repo.delete_many(pool, ids, permanent=permanent)


@router.get("", response_model=list[MaintenanceOut])
async def list_maintenance(
    device_id: str | None = None,
    team: str | None = None,
    pool=Depends(get_pool),
):
    return await repo.list_maintenance(pool, device_id, team)


@router.get("/page", response_model=MaintenancePage)
async def page_maintenance(
    limit: int = 20,
    offset: int = 0,
    order_by: str = "maintenance_date",
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


@router.get("/search", response_model=list[MaintenanceOut])
async def search_maintenance(q: str, pool=Depends(get_pool)):
    return await repo.search(pool, q)


@router.post("/{maintenance_id}/restore", response_model=MaintenanceOut)
async def restore_maintenance(maintenance_id: str, pool=Depends(get_pool)):
    if not await repo.restore(pool, maintenance_id):
        raise HTTPException(404, f"Maintenance not found: {maintenance_id}")
    return await repo.get(pool, maintenance_id)


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
async def delete_maintenance(
    maintenance_id: str, permanent: bool = False, pool=Depends(get_pool)
):
    action = repo.purge if permanent else repo.delete
    if not await action(pool, maintenance_id):
        raise HTTPException(404, f"Maintenance not found: {maintenance_id}")
