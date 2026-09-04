"""User schemas"""
from pydantic import BaseModel


class UserBase(BaseModel):
    name: str | None = None
    team: str | None = None
    # "active" | "retired". Employment status, NOT the trash: someone who has
    # left is still a real person whose handover history has to keep reading,
    # and who may still be holding a device that wants collecting.
    status: str | None = None


class UserCreate(UserBase):
    employee_code: str


class UserUpdate(UserBase):
    """All fields optional — only those sent are updated (partial PATCH)."""


class UserOut(UserCreate):
    pass

class UserDelete(BaseModel):
    employee_code: str