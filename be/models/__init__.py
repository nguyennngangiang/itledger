"""Pydantic request/response schemas, one module per resource."""
from .device import DeviceCreate, DeviceOut, DeviceUpdate
from .handover import HandoverCreate, HandoverOut, HandoverUpdate
from .maintenance import MaintenanceCreate, MaintenanceOut, MaintenanceUpdate
from .user import UserCreate, UserOut, UserUpdate

__all__ = [
    "DeviceCreate",
    "DeviceOut",
    "DeviceUpdate",
    "HandoverCreate",
    "HandoverOut",
    "HandoverUpdate",
    "MaintenanceCreate",
    "MaintenanceOut",
    "MaintenanceUpdate",
    "UserCreate",
    "UserOut",
    "UserUpdate",
]
