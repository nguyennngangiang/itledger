"""Devices REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/device.py.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..db import get_pool
from ..models.device import DeviceCreate, DeviceOut, DeviceUpdate
from ..repositories import device as repo
from ..repositories.errors import DuplicateError, ForeignKeyError

router = APIRouter(prefix="/devices", tags=["devices"])


@router.post("", response_model=DeviceOut, status_code=201)
async def create_device(device: DeviceCreate, pool=Depends(get_pool)):
    try:
        return await repo.create(pool, device)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))


@router.get("", response_model=list[DeviceOut])
async def list_devices(user_id: str | None = None, pool=Depends(get_pool)):
    return await repo.list_devices(pool, user_id)


@router.get("/{serial_number}", response_model=DeviceOut)
async def get_device(serial_number: str, pool=Depends(get_pool)):
    device = await repo.get(pool, serial_number)
    if device is None:
        raise HTTPException(404, f"Device not found: {serial_number}")
    return device


@router.patch("/{serial_number}", response_model=DeviceOut)
async def update_device(
    serial_number: str, device: DeviceUpdate, pool=Depends(get_pool)
):
    try:
        updated = await repo.update(pool, serial_number, device)
    except DuplicateError as e:
        raise HTTPException(409, str(e))
    except ForeignKeyError as e:
        raise HTTPException(409, str(e))
    if updated is None:
        raise HTTPException(404, f"Device not found: {serial_number}")
    return updated


@router.delete("/{serial_number}", status_code=204)
async def delete_device(serial_number: str, pool=Depends(get_pool)):
    if not await repo.delete(pool, serial_number):
        raise HTTPException(404, f"Device not found: {serial_number}")
