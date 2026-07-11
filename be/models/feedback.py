"""Search-feedback schemas — the labeled 'this result is right' marks that
steer / train the LLM reranker.

`label` is 1 for a relevant (correct) hit, 0 for an explicit not-relevant mark.
`document` and `score` capture the proof the user saw at mark time, so the
training data is self-contained even if the device later changes.
"""
from datetime import datetime

from pydantic import BaseModel


class FeedbackCreate(BaseModel):
    query: str
    device_id: str | None = None
    document: str | None = None
    score: float | None = None
    label: int = 1


class FeedbackOut(FeedbackCreate):
    id: int
    created_at: datetime
