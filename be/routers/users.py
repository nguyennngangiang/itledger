"""Users REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/user.py.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..db import get_pool
from ..models.user import UserCreate, UserOut, UserUpdate, UserDelete
from ..repositories import user as repo
from ..repositories.errors import DuplicateError

router = APIRouter(prefix="/users", tags=["users"])


@router.post("", response_model=UserOut, status_code=201)
async def create_user(user: UserCreate, pool=Depends(get_pool)):
    try:
        return await repo.create(pool, user)
    except DuplicateError as e:
        raise HTTPException(409, str(e))

@router.post("/batch", response_model=list[UserOut], status_code=201)
async def create_user_batch(users: list[UserCreate], pool=Depends(get_pool)):
    try:
        return await repo.create_batch(pool, users)
    except DuplicateError as e:
        raise HTTPException(409, str(e))

@router.get("", response_model=list[UserOut])
async def list_users(team: str | None = None, pool=Depends(get_pool)):
    return await repo.list_users(pool, team)


@router.get("/search", response_model=list[UserOut])
async def search_users(q: str, pool=Depends(get_pool)):
    return await repo.search(pool, q)


@router.get("/{employee_code}", response_model=UserOut)
async def get_user(employee_code: str, pool=Depends(get_pool)):
    user = await repo.get(pool, employee_code)
    if user is None:
        raise HTTPException(404, f"User not found: {employee_code}")
    return user


@router.patch("/{employee_code}", response_model=UserOut)
async def update_user(
    employee_code: str, user: UserUpdate, pool=Depends(get_pool)
):
    updated = await repo.update(pool, employee_code, user)
    if updated is None:
        raise HTTPException(404, f"User not found: {employee_code}")
    return updated


@router.delete("", status_code=204)
async def delete_user(user: UserDelete, pool=Depends(get_pool)):
    if not await repo.delete(pool, user.employee_code):
        raise HTTPException(404, f"Device not found: {user.employee_code}")

@router.delete("/batch", status_code=204)
async def delete_user_batch(users: list[UserDelete], pool=Depends(get_pool)):
    for user in users:
        if not await repo.delete(pool, user.employee_code):
            raise HTTPException(404, f"User not found: {user.employee_code}")

