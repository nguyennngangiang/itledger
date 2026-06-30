"""Device schemas"""
from datetime import date

from pydantic import BaseModel


class DeviceBase(BaseModel):
    barcode: str | None = None
    type: str | None = None
    brand: str | None = None
    cpu: str | None = None
    ram: str | None = None
    storage: str | None = None
    os: str | None = None
    msoffice: str | None = None
    buy_date: date | None = None
    name: str | None = None
    user_id: str | None = None


class DeviceCreate(DeviceBase):
    serial_number: str


class DeviceUpdate(DeviceBase):
    """All fields optional — only those sent are updated (partial PATCH)."""


class DeviceOut(DeviceCreate):
    pass

class DeviceDelete(BaseModel):
    serial_number: str