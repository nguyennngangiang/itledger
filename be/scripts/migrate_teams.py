import asyncio
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
from be.config import settings  # noqa: E402

MIGRATION = Path(__file__).resolve().parents[1] / "sql" / "migrate_teams_snake_case.sql"
SEED = Path(__file__).resolve().parents[1] / "sql" / "seed_teams.sql"


async def main() -> None:
    conn = await asyncpg.connect(settings.database_url)
    migration = MIGRATION.read_text(encoding="utf-8")
    seed = SEED.read_text(encoding="utf-8")

    async with conn.transaction():
        for statement in migration.split(";"):
            stmt = statement.strip()
            if stmt:
                await conn.execute(stmt)
        for statement in seed.split(";"):
            stmt = statement.strip()
            if stmt:
                await conn.execute(stmt)

    rows = await conn.fetch(
        "SELECT team_id, team_name FROM teams ORDER BY team_id"
    )
    for r in rows:
        print(dict(r))
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
