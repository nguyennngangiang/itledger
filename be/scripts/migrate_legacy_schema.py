"""Apply legacy column renames idempotently against the app database."""
import asyncio
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
from be.config import settings  # noqa: E402

RENAMES: list[tuple[str, str, str]] = [
    ("maintenance", "maintenanceid", "maintenance_id"),
    ("maintenance", "maintenancedate", "maintenance_date"),
    ("maintenance", "deviceid", "device_id"),
    ("maintenance", "costvnd", "cost_vnd"),
    ("handovers", "handoverid", "handover_id"),
    ("handovers", "handoverdate", "handover_date"),
    ("handovers", "deviceid", "device_id"),
    ("user_devices", "userid", "user_id"),
    ("user_devices", "deviceid", "device_id"),
    ("teams", "teamid", "team_id"),
    ("teams", "teamname", "team_name"),
    ("devices", "buydate", "buy_date"),
    ("devices", "userid", "user_id"),
]


async def main() -> None:
    conn = await asyncpg.connect(settings.database_url)
    async with conn.transaction():
        for table, old_name, new_name in RENAMES:
            exists = await conn.fetchval(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = $1 "
                "AND column_name = $2",
                table,
                old_name,
            )
            if exists:
                await conn.execute(
                    f'ALTER TABLE {table} RENAME COLUMN {old_name} TO {new_name}'
                )
                print(f"Renamed {table}.{old_name} -> {new_name}")
            else:
                print(f"Skip {table}.{old_name} (already migrated)")
    await conn.close()
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
