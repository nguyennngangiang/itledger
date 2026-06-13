import asyncio
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from be.config import settings  # noqa: E402

MIGRATION = Path(__file__).resolve().parents[1] / "sql" / "migrate_devices_snake_case.sql"


async def main() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    conn = await asyncpg.connect(settings.database_url)
    try:
        await conn.execute(sql)
        print("Migration applied:", MIGRATION.name)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
