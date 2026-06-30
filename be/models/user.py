"""User schemas"""
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

class UserDelete(BaseModel):
    employee_code: str