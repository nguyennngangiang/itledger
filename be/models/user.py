"""User schemas. Field names match the snake_case columns in sql/schema.sql,
so a DB row (asyncpg Record -> dict) maps straight onto these models.
"""
from pydantic import BaseModel


class UserBase(BaseModel):
    name: str | None = None
    team: str | None = None


class UserCreate(UserBase):
    employee_code: str


class UserUpdate(UserBase):
    """All fields optional — only those sent are updated (partial PATCH)."""


class UserOut(UserCreate):
    pass
