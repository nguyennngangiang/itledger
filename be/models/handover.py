"""Handover schemas"""
from datetime import date

from pydantic import BaseModel


class HandoverBase(BaseModel):
    handover_date: date | None = None
    device_id: str | None = None
    from_user_id: str | None = None
    to_user_id: str | None = None
    reason: str | None = None


class HandoverCreate(HandoverBase):
    handover_id: str


class HandoverUpdate(HandoverBase):
    """All fields optional — only those sent are updated (partial PATCH)."""


class HandoverOut(HandoverCreate):
    pass
