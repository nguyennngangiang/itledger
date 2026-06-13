"""Team data access. SQL lives here; the router stays thin."""
import asyncpg

COLUMNS = "team_id, team_name, division"


async def list_teams(pool: asyncpg.Pool) -> list[dict]:
    rows = await pool.fetch(f"SELECT {COLUMNS} FROM teams ORDER BY team_id")
    return [dict(r) for r in rows]
