"""Teams REST resource — thin HTTP layer."""
from fastapi import APIRouter, Depends

from ..db import get_pool
from ..models.team import TeamOut
from ..repositories import team as repo

router = APIRouter(prefix="/teams", tags=["teams"])


@router.get("", response_model=list[TeamOut])
async def list_teams(pool=Depends(get_pool)):
    return await repo.list_teams(pool)
