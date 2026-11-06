"""Read-only queries behind the GLPI export (be/export_glpi.py).

The SQL lives here rather than in the script because the export is reachable two
ways — the CLI and `GET /export/glpi` — and this repo keeps every statement in
`repositories/`. Nothing here writes.

Every query filters `deleted_at IS NULL`: the trash must never reach GLPI.
Ordering is part of the contract, not a nicety:

* devices by serial, so two runs over unchanged data produce identical files;
* handovers by (date, id), because the importer walks the file top to bottom and
  carries each asset's holder from one row to the next — order *is* the history;
* maintenance by (date, id), for determinism.

`NULLS LAST` only matters for that determinism. Undated rows are dropped by the
caller, since the importer's dedup key is built on the date.

The parameter is `$1::date`, with `NULL` meaning "no filter" — one statement
instead of two, and asyncpg still needs the cast to type the NULL.
"""
import asyncpg
from datetime import date

from ..constants import GHOST_CODE

DEVICE_SQL = """
    SELECT serial_number, barcode, type, brand, cpu, ram, storage, os,
           msoffice, buy_date, name, user_id, status
      FROM devices
     WHERE deleted_at IS NULL
     ORDER BY serial_number
"""

HANDOVER_SQL = """
    SELECT handover_id, handover_date, device_id, from_user_id, to_user_id, reason
      FROM handovers
     WHERE deleted_at IS NULL
       AND ($1::date IS NULL OR handover_date >= $1)
     ORDER BY handover_date NULLS LAST, handover_id
"""

MAINTENANCE_SQL = """
    SELECT maintenance_id, maintenance_date, device_id, team, part, reason,
           solution, result, cost_vnd, remarks
      FROM maintenance
     WHERE deleted_at IS NULL
       AND ($1::date IS NULL OR maintenance_date >= $1)
     ORDER BY maintenance_date NULLS LAST, maintenance_id
"""

# Codes GLPI may not hold. `yicorgsync` syncs OP staff into
# `glpi_users.sync_field = 'op:staff:<CODE>'`; a retired or soft-deleted person
# can be missing there, which turns that row into a `user_not_synced` issue at
# import time. There is no OP list on this side of the wall, so the ledger's own
# users table is the closest check available — a warning, never a filter.
RISKY_CODES_SQL = """
    SELECT employee_code, status, (deleted_at IS NOT NULL) AS removed
      FROM users
     WHERE employee_code <> $1
       AND (status <> 'active' OR deleted_at IS NOT NULL)
"""


async def devices(pool: asyncpg.Pool) -> list:
    """Every live device. Always full: see the note in be/export_glpi.py."""
    return await pool.fetch(DEVICE_SQL)


async def handovers(pool: asyncpg.Pool, since: date | None = None) -> list:
    return await pool.fetch(HANDOVER_SQL, since)


async def maintenance(pool: asyncpg.Pool, since: date | None = None) -> list:
    return await pool.fetch(MAINTENANCE_SQL, since)


async def risky_codes(pool: asyncpg.Pool) -> list:
    """Ledger users who are not plain active — candidates for `user_not_synced`."""
    return await pool.fetch(RISKY_CODES_SQL, GHOST_CODE)
