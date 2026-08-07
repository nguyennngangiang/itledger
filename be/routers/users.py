"""Users REST resource — thin HTTP layer.

Parse the request, call the repository, translate domain errors / missing rows
to HTTP status codes. No SQL here — that lives in repositories/user.py.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..db import get_pool
from ..models.user import UserCreate, UserOut, UserUpdate, UserDelete
from ..repositories import user as repo
from ..repositories.errors import (
    DuplicateError,
    ForeignKeyError,
    InUseError,
    ProtectedError,
)

router = APIRouter(prefix="/users", tags=["users"])


class UserPage(BaseModel):
    rows: list[UserOut]
    total: int


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


@router.post("/restore", response_model=UserOut)
async def restore_user(user: UserDelete, pool=Depends(get_pool)):
    if not await repo.restore(pool, user.employee_code):
        raise HTTPException(404, f"User not found: {user.employee_code}")
    return await repo.get(pool, user.employee_code)


@router.get("", response_model=list[UserOut])
async def list_users(
    team: str | None = None,
    include_deleted: bool = False,
    pool=Depends(get_pool),
):
    """Active staff. `include_deleted=true` also returns trashed people, for the
    screens' display lookup maps so old history keeps showing names — not for
    owner pickers."""
    return await repo.list_users(pool, team, include_deleted)


# Declared before /{employee_code} so "page" / "search" / "teams" are not read
# as employee codes.
# Excludes the IT-STORE ghost — it is not an employee. See repo.list_page.
@router.get("/page", response_model=UserPage)
async def page_users(
    limit: int = 20,
    offset: int = 0,
    order_by: str = "employee_code",
    order: str = "asc",
    deleted: bool = False,
    q: str | None = None,
    team: str | None = None,
    status: str | None = None,
    no_team: bool = False,
    pool=Depends(get_pool),
):
    rows, total = await repo.list_page(
        pool,
        limit=limit,
        offset=offset,
        order_by=order_by,
        order=order,
        deleted=deleted,
        q=q,
        team=team,
        status=status,
        no_team=no_team,
    )
    return {"rows": rows, "total": total}


@router.get("/search", response_model=list[UserOut])
async def search_users(q: str, pool=Depends(get_pool)):
    return await repo.search(pool, q)


@router.get("/teams", response_model=list[str])
async def list_teams(pool=Depends(get_pool)):
    """Team names actually present in the data — backs the team autocomplete.
    There is no teams table, so this is the only honest source."""
    return await repo.list_teams(pool)


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
    try:
        updated = await repo.update(pool, employee_code, user)
    except ProtectedError as e:
        raise HTTPException(409, str(e))
    if updated is None:
        raise HTTPException(404, f"User not found: {employee_code}")
    return updated


@router.delete("", status_code=204)
async def delete_user(
    user: UserDelete, permanent: bool = False, pool=Depends(get_pool)
):
    action = repo.purge if permanent else repo.delete
    try:
        if not await action(pool, user.employee_code):
            raise HTTPException(404, f"User not found: {user.employee_code}")
    except (ProtectedError, InUseError, ForeignKeyError) as e:
        # Refusing on purpose: the ghost account, someone still holding
        # devices, or history that still references them.
        raise HTTPException(409, str(e))

@router.delete("/batch", status_code=204)
async def delete_user_batch(
    codes: list[str], permanent: bool = False, pool=Depends(get_pool)
):
    """Bulk delete by employee code. Soft-delete by default; `permanent=true`
    purges from the trash. Unknown codes are ignored (no 404), but a protected
    or still-in-use code fails the whole call rather than being skipped."""
    try:
        await repo.delete_many(pool, codes, permanent=permanent)
    except (ProtectedError, InUseError, ForeignKeyError) as e:
        raise HTTPException(409, str(e))
