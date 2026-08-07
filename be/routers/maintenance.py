"""Maintenance REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/maintenance.py.
"""
from fastapi import APIRouter, Body, Depends, HTTPException

from ..db import get_pool
from ..documents import maintenance_document
from ..search import rank
from .. import llm
from ..models.maintenance import MaintenanceCreate, MaintenanceOut, MaintenanceUpdate
from ..models.page import ImportResult, Page, Ranked
from ..repositories import maintenance as repo
from ..repositories import device as device_repo
from ..repositories import feedback as feedback_repo
from ..repositories import user as user_repo

router = APIRouter(prefix="/maintenance", tags=["maintenance"])

# DuplicateError / ForeignKeyError are mapped to 409 centrally in main.py.
MaintenancePage = Page[MaintenanceOut]


class MaintenanceRanked(MaintenanceOut, Ranked):
    """A maintenance record plus its semantic-similarity score (0–1), the exact
    sentence the embedder ranked it on (`document`), and the LLM reranker's
    one-line `reason` when it ran."""


@router.post("", response_model=MaintenanceOut, status_code=201)
async def create_maintenance(maintenance: MaintenanceCreate, pool=Depends(get_pool)):
    return await repo.create(pool, maintenance)


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


@router.post("/import", response_model=ImportResult)
async def import_maintenance(
    records: list[MaintenanceCreate], pool=Depends(get_pool)
):
    """Bulk-insert parsed repair rows. Re-importing the same file is idempotent —
    see repo.import_maintenance for why the dedup key is (device, date, part) and
    not the id. Rows naming an unknown serial are skipped, not rejected, so one bad
    line cannot fail the whole sheet. Declared before /{maintenance_id}."""
    return await repo.import_maintenance(pool, records)


@router.get("/search", response_model=list[MaintenanceOut])
async def search_maintenance(q: str, pool=Depends(get_pool)):
    return await repo.search(pool, q)


@router.get("/suggestions", response_model=dict[str, list[str]])
async def maintenance_suggestions(pool=Depends(get_pool)):
    """Values already used, per column — feeds the repair form's autocompletes,
    so it suggests the phrasing the team actually writes. One response for every
    suggestable column. Declared before /{maintenance_id} so "suggestions" isn't
    read as an id."""
    return await repo.suggestions(pool)


@router.get("/semantic-search", response_model=list[MaintenanceRanked])
async def semantic_search(
    q: str, limit: int = 20, rerank: bool = False, pool=Depends(get_pool)
):
    """Rank active maintenance records by how well they match a natural-language
    query, using the local embedding service. With `rerank=true` the LLM re-sorts
    the results, learning from this project's marked-correct feedback. Declared
    before /{maintenance_id} so "semantic-search" isn't read as an id."""
    records = await repo.list_maintenance(pool)
    if not records:
        return []

    devices = {d["serial_number"]: d for d in await device_repo.list_devices(pool)}
    users = {u["employee_code"]: u for u in await user_repo.list_users(pool)}
    documents = [
        {"id": m["maintenance_id"], "text": maintenance_document(m, devices, users)}
        for m in records
    ]
    text_by_id = {doc["id"]: doc["text"] for doc in documents}

    ranked = await rank(q, documents, limit)

    by_id = {m["maintenance_id"]: m for m in records}
    results = [
        {
            **by_id[r["id"]],
            "score": round(r["score"], 4),
            "document": text_by_id[r["id"]],
        }
        for r in ranked
        if r["id"] in by_id
    ]

    if rerank and results:
        examples = await feedback_repo.examples_for_query(pool, "maintenance", q)
        results = await llm.rerank_results(q, results, examples, "maintenance_id")

    return results


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
    updated = await repo.update(pool, maintenance_id, maintenance)
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
