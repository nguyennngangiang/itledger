"""Handovers REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/handover.py.
"""
from fastapi import APIRouter, Body, Depends, HTTPException

from ..db import get_pool
from ..documents import handover_document
from ..search import rank
from .. import handover_import, llm
from ..models.handover import HandoverCreate, HandoverOut, HandoverUpdate
from ..models.page import Page, Ranked
from ..repositories import handover as repo
from ..repositories import device as device_repo
from ..repositories import feedback as feedback_repo
from ..repositories import user as user_repo

router = APIRouter(prefix="/handovers", tags=["handovers"])

# DuplicateError / ForeignKeyError are mapped to 409 centrally in main.py. The
# 422s in _reject_meaningless stay local — they are this resource's own rule,
# not a repository refusal.
HandoverPage = Page[HandoverOut]


class HandoverRanked(HandoverOut, Ranked):
    """A handover record plus its semantic-similarity score (0–1), the exact
    sentence the embedder ranked it on (`document`), and the LLM reranker's
    one-line `reason` when it ran."""


def _reject_meaningless(from_user_id: str | None, to_user_id: str | None) -> None:
    """A handover has to move the machine between two different people.

    The live ledger carries thirteen rows that do neither — seven with no
    recipient at all and six where a person hands a device to themselves. They
    came in through the original workbook import and say nothing about where the
    machine went, while still counting as the device's latest event. Refuse to
    add more.
    """
    if not (to_user_id or "").strip():
        raise HTTPException(422, "Người nhận không được để trống.")
    if (from_user_id or "").strip() == (to_user_id or "").strip():
        raise HTTPException(422, "Người giao và người nhận phải khác nhau.")


@router.post("", response_model=HandoverOut, status_code=201)
async def create_handover(handover: HandoverCreate, pool=Depends(get_pool)):
    _reject_meaningless(handover.from_user_id, handover.to_user_id)
    return await repo.create(pool, handover)


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


@router.get("/suggestions", response_model=dict[str, list[str]])
async def handover_suggestions(pool=Depends(get_pool)):
    """Values already used, per column — feeds the handover form's Reason
    autocomplete. The form used to offer a hardcoded list only, so the phrasing the
    team actually writes ("Device replacement", "Trả về kho") never surfaced.
    Declared before /{handover_id} so "suggestions" isn't read as an id.

    Also carries `return_phrases`, so the form can recognise a return without
    keeping its own copy of the wording — the copy it used to keep had drifted and
    no longer matched what the backend acted on. The form pairs every phrase with
    the recipient's team, exactly as `store_recipient` does, so it gets the whole
    list including the both-directions ones like "Replacement".
    """
    return {
        **await repo.suggestions(pool),
        # Not a column, so it stays here rather than in the repo's map.
        "return_phrases": list(handover_import.RETURN_WHEN_TO_IT),
    }


@router.get("/semantic-search", response_model=list[HandoverRanked])
async def semantic_search(
    q: str, limit: int = 20, rerank: bool = False, pool=Depends(get_pool)
):
    """Rank active handover records by how well they match a natural-language
    query, using the local embedding service. With `rerank=true` the LLM re-sorts
    the results, learning from this project's marked-correct feedback. Declared
    before /{handover_id} so "semantic-search" isn't read as an id."""
    records = await repo.list_handovers(pool)
    if not records:
        return []

    devices = {d["serial_number"]: d for d in await device_repo.list_devices(pool)}
    users = {u["employee_code"]: u for u in await user_repo.list_users(pool)}
    documents = [
        {"id": h["handover_id"], "text": handover_document(h, devices, users)}
        for h in records
    ]
    text_by_id = {doc["id"]: doc["text"] for doc in documents}

    ranked = await rank(q, documents, limit)

    by_id = {h["handover_id"]: h for h in records}
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
        examples = await feedback_repo.examples_for_query(pool, "handovers", q)
        results = await llm.rerank_results(q, results, examples, "handover_id")

    return results


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
    # PATCH is partial, so check the values the row will END UP with.
    current = await repo.get(pool, handover_id)
    if current is None:
        raise HTTPException(404, f"Handover not found: {handover_id}")
    sent = handover.model_dump(exclude_unset=True)
    _reject_meaningless(
        sent.get("from_user_id", current["from_user_id"]),
        sent.get("to_user_id", current["to_user_id"]),
    )
    updated = await repo.update(pool, handover_id, handover)
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
