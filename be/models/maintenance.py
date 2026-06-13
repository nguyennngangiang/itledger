"""Maintenance schemas. Field names match the snake_case columns in sql/schema.sql,
so a DB row (asyncpg Record -> dict) maps straight onto these models.
"""
from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class MaintenanceBase(BaseModel):
    maintenance_date: date | None = None
    device_id: str | None = None
    team: str | None = None
    part: str | None = None
    reason: str | None = None
    solution: str | None = None
    result: str | None = None
    cost_vnd: Decimal | None = None
    remarks: str | None = None


class MaintenanceCreate(MaintenanceBase):
    maintenance_id: str


class MaintenanceUpdate(MaintenanceBase):
    """All fields optional — only those sent are updated (partial PATCH)."""


class MaintenanceOut(MaintenanceCreate):
    pass
