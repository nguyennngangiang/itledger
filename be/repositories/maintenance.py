"""Maintenance data access. SQL lives here; the router stays thin.

asyncpg uses $1, $2 ... placeholders — never string-format user values into SQL.
"""
import asyncpg

from ..models.maintenance import MaintenanceCreate, MaintenanceUpdate
from . import device_owner_match
from .errors import DuplicateError, ForeignKeyError

COLUMNS = (
    "maintenance_id, maintenance_date, device_id, team, part, "
    "reason, solution, result, cost_vnd, remarks"
)


async def create(pool: asyncpg.Pool, maintenance: MaintenanceCreate) -> dict:
    try:
        row = await pool.fetchrow(
            f"""INSERT INTO maintenance ({COLUMNS})
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING {COLUMNS}""",
            maintenance.maintenance_id,
            maintenance.maintenance_date,
            maintenance.device_id,
            maintenance.team,
            maintenance.part,
            maintenance.reason,
            maintenance.solution,
            maintenance.result,
            maintenance.cost_vnd,
            maintenance.remarks,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(
            f"Maintenance already exists: {maintenance.maintenance_id}"
        ) from e
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(
            f"Unknown device_id: {maintenance.device_id}"
        ) from e
    return dict(row)


async def import_maintenance(
    pool: asyncpg.Pool, records: list[MaintenanceCreate]
) -> dict:
    """Bulk import repair history from an uploaded xlsx/csv. One transaction.
    Returns {inserted, skipped, total}.

    Idempotency cannot ride on the primary key the way import_devices does: a
    device has a real serial, but `maintenance_id` is a UUID minted per row
    (fe/src/lib/id.ts), so re-importing the same file would mint new ids and
    duplicate every repair. The natural key is what the record describes instead —
    the same device, on the same date, for the same part — so a row matching an
    existing one on those three is skipped.

    A row naming a device that isn't in the fleet is also skipped rather than
    raising: one unknown serial in a hundred-row sheet should not reject the file.
    Both cases land in `skipped`, so the count is honest about what wasn't taken.
    """
    inserted = 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for record in records:
                exists = await conn.fetchval(
                    """SELECT 1 FROM maintenance
                       WHERE device_id = $1
                         AND maintenance_date IS NOT DISTINCT FROM $2
                         AND part IS NOT DISTINCT FROM $3
                       LIMIT 1""",
                    record.device_id, record.maintenance_date, record.part,
                )
                if exists:
                    continue
                known_device = await conn.fetchval(
                    "SELECT 1 FROM devices WHERE serial_number = $1", record.device_id
                )
                if not known_device:
                    continue
                await conn.execute(
                    f"""INSERT INTO maintenance ({COLUMNS})
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
                    record.maintenance_id, record.maintenance_date, record.device_id,
                    record.team, record.part, record.reason, record.solution,
                    record.result, record.cost_vnd, record.remarks,
                )
                inserted += 1
    return {"inserted": inserted, "skipped": len(records) - inserted,
            "total": len(records)}


async def list_maintenance(
    pool: asyncpg.Pool,
    device_id: str | None = None,
    team: str | None = None,
) -> list[dict]:
    conditions: list[str] = ["deleted_at IS NULL"]
    params: list[str] = []

    if device_id:
        params.append(device_id)
        conditions.append(f"device_id = ${len(params)}")
    if team:
        params.append(team)
        conditions.append(f"team = ${len(params)}")

    where = f" WHERE {' AND '.join(conditions)}"
    # Newest first, same reasoning as handovers: maintenance_id is a generated
    # UUID, so the repair story rendered in date-agnostic order.
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM maintenance{where} "
        f"ORDER BY maintenance_date DESC NULLS LAST, maintenance_id",
        *params,
    )
    return [dict(r) for r in rows]


SORTABLE_FIELDS = frozenset({
    "maintenance_id", "maintenance_date", "device_id", "team", "part",
    "result", "cost_vnd",
})

# Columns offered as form autocomplete (see repositories.distinct_values).
# These are the free-text fields the team keeps re-typing the same phrases into.
SUGGESTABLE_FIELDS = frozenset({"part", "result", "solution", "reason", "team"})


async def list_page(
    pool: asyncpg.Pool,
    *,
    limit: int = 20,
    offset: int = 0,
    order_by: str = "maintenance_date",
    order: str = "desc",
    deleted: bool = False,
    q: str | None = None,
) -> tuple[list[dict], int]:
    conditions = ["deleted_at IS NOT NULL" if deleted else "deleted_at IS NULL"]
    params: list = []
    if q:
        params.append(f"%{q}%")
        i = len(params)
        conditions.append(
            f"(device_id ILIKE ${i} OR part ILIKE ${i} OR team ILIKE ${i} "
            f"OR unaccent(reason) ILIKE unaccent(${i}) "
            f"OR unaccent(solution) ILIKE unaccent(${i}) "
            f"OR unaccent(result) ILIKE unaccent(${i}) "
            f"OR unaccent(remarks) ILIKE unaccent(${i}) "
            f"OR {device_owner_match('maintenance.device_id', i)})"
        )
    where = " WHERE " + " AND ".join(conditions)
    ob = order_by if order_by in SORTABLE_FIELDS else "maintenance_date"
    od = "DESC" if str(order).lower() == "desc" else "ASC"

    total = await pool.fetchval(f"SELECT count(*) FROM maintenance{where}", *params)
    params.append(limit)
    params.append(offset)
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM maintenance{where} "
        f"ORDER BY {ob} {od}, maintenance_id LIMIT ${len(params) - 1} OFFSET ${len(params)}",
        *params,
    )
    return [dict(r) for r in rows], total


async def search(pool: asyncpg.Pool, q: str) -> list[dict]:
    pattern = f"%{q}%"
    rows = await pool.fetch(
        f"""SELECT {COLUMNS} FROM maintenance
            WHERE deleted_at IS NULL
              AND (device_id ILIKE $1 OR part ILIKE $1 OR team ILIKE $1
                   OR unaccent(reason) ILIKE unaccent($1)
                   OR unaccent(solution) ILIKE unaccent($1)
                   OR unaccent(result) ILIKE unaccent($1)
                   OR unaccent(remarks) ILIKE unaccent($1)
                   OR {device_owner_match('maintenance.device_id', 1)})
            ORDER BY maintenance_id""",
        pattern,
    )
    return [dict(r) for r in rows]


async def get(pool: asyncpg.Pool, maintenance_id: str) -> dict | None:
    row = await pool.fetchrow(
        f"SELECT {COLUMNS} FROM maintenance WHERE maintenance_id = $1",
        maintenance_id,
    )
    return dict(row) if row else None


async def update(
    pool: asyncpg.Pool, maintenance_id: str, maintenance: MaintenanceUpdate
) -> dict | None:
    fields = maintenance.model_dump(exclude_unset=True)
    if not fields:
        return await get(pool, maintenance_id)

    cols = list(fields.keys())
    set_clause = ", ".join(f"{c} = ${i + 1}" for i, c in enumerate(cols))
    try:
        row = await pool.fetchrow(
            f"""UPDATE maintenance SET {set_clause}
                WHERE maintenance_id = ${len(cols) + 1}
                RETURNING {COLUMNS}""",
            *fields.values(),
            maintenance_id,
        )
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(
            f"Unknown device_id: {fields.get('device_id')}"
        ) from e
    return dict(row) if row else None


async def delete(pool: asyncpg.Pool, maintenance_id: str) -> bool:
    result = await pool.execute(
        "UPDATE maintenance SET deleted_at = now() "
        "WHERE maintenance_id = $1 AND deleted_at IS NULL",
        maintenance_id,
    )
    return result != "UPDATE 0"


async def restore(pool: asyncpg.Pool, maintenance_id: str) -> bool:
    result = await pool.execute(
        "UPDATE maintenance SET deleted_at = NULL WHERE maintenance_id = $1",
        maintenance_id,
    )
    return result != "UPDATE 0"


async def purge(pool: asyncpg.Pool, maintenance_id: str) -> bool:
    result = await pool.execute(
        "DELETE FROM maintenance WHERE maintenance_id = $1", maintenance_id
    )
    return result != "DELETE 0"


async def counts_by_device(pool: asyncpg.Pool) -> dict[str, int]:
    """{device_id: number of (non-deleted) maintenance records}. Used to enrich
    device documents for semantic search ("repaired N times")."""
    rows = await pool.fetch(
        "SELECT device_id, count(*) AS n FROM maintenance "
        "WHERE deleted_at IS NULL AND device_id IS NOT NULL "
        "GROUP BY device_id"
    )
    return {r["device_id"]: r["n"] for r in rows}


async def delete_many(
    pool: asyncpg.Pool, ids: list[str], *, permanent: bool = False
) -> int:
    """Bulk delete. Soft-deletes (or purges) every id in one round-trip.
    Lenient: unknown ids are skipped. Returns rows affected."""
    if not ids:
        return 0
    if permanent:
        result = await pool.execute(
            "DELETE FROM maintenance WHERE maintenance_id = ANY($1::text[])", ids
        )
    else:
        result = await pool.execute(
            "UPDATE maintenance SET deleted_at = now() "
            "WHERE maintenance_id = ANY($1::text[]) AND deleted_at IS NULL",
            ids,
        )
    return int(result.split()[-1])
