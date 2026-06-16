"""Team schemas"""
from pydantic import BaseModel


class TeamOut(BaseModel):
    team_id: str
    team_name: str | None = None
    division: str | None = None
