"""Team schemas. Field names match the snake_case columns in sql/schema.sql."""
from pydantic import BaseModel


class TeamOut(BaseModel):
    team_id: str
    team_name: str | None = None
    division: str | None = None
