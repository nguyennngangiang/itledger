"""Search-feedback REST resource — thin HTTP layer.

Captures the user's "this result is right" marks from the smart-search proof card.
The marks steer the LLM reranker per-project (few-shot anchors — see be/llm and
repositories/feedback). No SQL here.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..db import get_pool
from ..models.feedback import FeedbackCreate, FeedbackOut
from ..repositories import feedback as repo

router = APIRouter(prefix="/feedback", tags=["feedback"])


@router.post("", response_model=FeedbackOut, status_code=201)
async def create_feedback(fb: FeedbackCreate, pool=Depends(get_pool)):
    return await repo.create(pool, fb)


@router.get("", response_model=list[FeedbackOut])
async def list_feedback(limit: int = 500, pool=Depends(get_pool)):
    return await repo.list_feedback(pool, limit)


class FeedbackStats(BaseModel):
    total: int


@router.get("/stats", response_model=FeedbackStats)
async def feedback_stats(pool=Depends(get_pool)):
    return {"total": await repo.count(pool)}
