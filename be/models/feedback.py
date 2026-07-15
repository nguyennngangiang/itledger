"""Search-feedback schemas — the per-project signal that steers the LLM reranker.

These rows are stored in THIS project's DB and used only as few-shot anchors in
this project's prompts; the shared LLM is never trained. `resource` scopes a mark
to one screen (devices / maintenance / handovers).
"""
from datetime import datetime

from pydantic import BaseModel


class FeedbackCreate(BaseModel):
    resource: str  # "devices" | "maintenance" | "handovers"
    item_id: str
    query: str
    document: str | None = None
    score: float | None = None
    label: int = 1  # 1 = correct/relevant, 0 = not relevant


class FeedbackOut(FeedbackCreate):
    id: int
    created_at: datetime
