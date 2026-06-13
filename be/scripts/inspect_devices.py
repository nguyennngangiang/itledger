import asyncio
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from be.config import settings  # noqa: E402


async def main() -> None:
    conn = await asyncpg.connect(settings.database_url)
    rows = await conn.fetch(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'devices' ORDER BY ordinal_position"
    )
    print([r["column_name"] for r in rows])
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
