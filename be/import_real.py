"""One-shot importer for REAL-DATA.xlsx.

Deletes ALL existing rows and loads the cleaned data produced by
`_build_import.mjs` (import_data.json at the repo root).

Run inside the api container (reaches the `db` host):

    docker compose exec api python -m be.import_real

The JSON is already cleaned/deduped/FK-consistent; this script only converts
types (dates, decimals) and inserts via parameterized queries.
"""
import asyncio
import json
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

import asyncpg

from .config import settings

# import_data.json lives at the repo root (one level above be/).
DATA_FILE = Path(__file__).resolve().parent.parent / "import_data.json"


def to_date(v):
    if not v:
        return None
    try:
        y, m, d = (int(x) for x in str(v).split("-"))
        return date(y, m, d)
    except (ValueError, TypeError):
        return None


def to_dec(v):
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


async def run() -> None:
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    users = data["users"]
    devices = data["devices"]
    handovers = data["handovers"]
    maintenance = data["maintenance"]
    user_devices = data["user_devices"]

    conn = await asyncpg.connect(dsn=settings.database_url)
    try:
        async with conn.transaction():
            # Make sure optional columns exist (fresh DBs get them via schema.sql,
            # but be defensive for already-migrated ones).
            await conn.execute(
                "ALTER TABLE devices ADD COLUMN IF NOT EXISTS status VARCHAR(100)"
            )
            for tbl in ("devices", "maintenance", "handovers"):
                await conn.execute(
                    f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP"
                )

            # --- wipe everything ---
            await conn.execute(
                "TRUNCATE handovers, maintenance, user_devices, devices, users "
                "RESTART IDENTITY CASCADE"
            )

            # --- users ---
            await conn.executemany(
                """INSERT INTO users (employee_code, name, team)
                   VALUES ($1, $2, $3)""",
                [(u["employee_code"], u["name"], u["team"]) for u in users],
            )

            # --- devices ---
            await conn.executemany(
                """INSERT INTO devices (serial_number, barcode, type, brand, cpu,
                       ram, storage, os, msoffice, buy_date, name, user_id, status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)""",
                [(d["serial_number"], d["barcode"], d["type"], d["brand"], d["cpu"],
                  d["ram"], d["storage"], d["os"], d["msoffice"], to_date(d["buy_date"]),
                  d["name"], d["user_id"], d["status"]) for d in devices],
            )

            # --- user_devices (ownership mirror) ---
            await conn.executemany(
                """INSERT INTO user_devices (user_id, device_id)
                   VALUES ($1, $2) ON CONFLICT DO NOTHING""",
                [(ud["user_id"], ud["device_id"]) for ud in user_devices],
            )

            # --- handovers ---
            await conn.executemany(
                """INSERT INTO handovers (handover_id, handover_date, device_id,
                       from_user_id, to_user_id, reason)
                   VALUES ($1,$2,$3,$4,$5,$6)""",
                [(h["handover_id"], to_date(h["handover_date"]), h["device_id"],
                  h["from_user_id"], h["to_user_id"], h["reason"]) for h in handovers],
            )

            # --- maintenance ---
            await conn.executemany(
                """INSERT INTO maintenance (maintenance_id, maintenance_date, device_id,
                       team, part, reason, solution, result, cost_vnd, remarks)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
                [(m["maintenance_id"], to_date(m["maintenance_date"]), m["device_id"],
                  m["team"], m["part"], m["reason"], m["solution"], m["result"],
                  to_dec(m["cost_vnd"]), m["remarks"]) for m in maintenance],
            )

        counts = await conn.fetchrow(
            """SELECT (SELECT count(*) FROM users)      AS users,
                      (SELECT count(*) FROM devices)     AS devices,
                      (SELECT count(*) FROM handovers)   AS handovers,
                      (SELECT count(*) FROM maintenance) AS maintenance"""
        )
        print(
            f"Import complete. Totals -> users={counts['users']}, "
            f"devices={counts['devices']}, handovers={counts['handovers']}, "
            f"maintenance={counts['maintenance']}"
        )
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(run())
