"""Device data access. SQL lives here; the router stays thin.

This is the template to clone for user / handover / maintenance repos.
asyncpg uses $1, $2 ... placeholders — never string-format user values into SQL.
"""
import asyncpg

from ..models.device import DeviceCreate, DeviceUpdate
from .errors import DuplicateError, ForeignKeyError

# Shared column list so SELECT / RETURNING always match the DeviceOut shape.
COLUMNS = (
    "serial_number, barcode, type, brand, cpu, ram, storage, "
    "os, msoffice, buy_date, name, user_id, status"
)

async def create_batch(pool: asyncpg.Pool, devices: list[DeviceCreate]) -> list[dict]:
    try:
        rows = []
        for device in devices:
            row = await pool.fetchrow(
                f"""INSERT INTO devices ({COLUMNS})
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                    RETURNING {COLUMNS}""",
                device.serial_number, device.barcode, device.type, device.brand,
                device.cpu, device.ram, device.storage, device.os, device.msoffice,
                device.buy_date, device.name, device.user_id, device.status,
            )
            rows.append(dict(row))
        return rows
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"Device already exists: {device.serial_number}") from e
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(f"Unknown user_id: {device.user_id}") from e

async def create(pool: asyncpg.Pool, device: DeviceCreate) -> dict:
    try:
        row = await pool.fetchrow(
            f"""INSERT INTO devices ({COLUMNS})
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                RETURNING {COLUMNS}""",
            device.serial_number, device.barcode, device.type, device.brand,
            device.cpu, device.ram, device.storage, device.os, device.msoffice,
            device.buy_date, device.name, device.user_id, device.status,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"Device already exists: {device.serial_number}") from e
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(f"Unknown user_id: {device.user_id}") from e
    return dict(row)


async def list_devices(pool: asyncpg.Pool, user_id: str | None = None) -> list[dict]:
    # Reference-data fetch (owner maps, dashboard): excludes soft-deleted rows.
    if user_id:
        rows = await pool.fetch(
            f"SELECT {COLUMNS} FROM devices "
            f"WHERE user_id = $1 AND deleted_at IS NULL ORDER BY serial_number",
            user_id,
        )
    else:
        rows = await pool.fetch(
            f"SELECT {COLUMNS} FROM devices WHERE deleted_at IS NULL "
            f"ORDER BY serial_number"
        )
    return [dict(r) for r in rows]


# Columns allowed in ORDER BY (name is interpolated, so it MUST be allowlisted).
SORTABLE_FIELDS = frozenset({
    "serial_number", "name", "brand", "type", "cpu", "ram", "storage",
    "os", "msoffice", "buy_date", "user_id", "status",
})


async def list_page(
    pool: asyncpg.Pool,
    *,
    limit: int = 20,
    offset: int = 0,
    order_by: str = "serial_number",
    order: str = "asc",
    deleted: bool = False,
    q: str | None = None,
    status: str | None = None,
) -> tuple[list[dict], int]:
    """Paginated + sortable + searchable device list. Returns (rows, total)."""
    conditions = ["deleted_at IS NOT NULL" if deleted else "deleted_at IS NULL"]
    params: list = []
    if status:
        params.append(status)
        conditions.append(f"status = ${len(params)}")
    if q:
        params.append(f"%{q}%")
        i = len(params)
        conditions.append(
            f"(serial_number ILIKE ${i} OR name ILIKE ${i} "
            f"OR brand ILIKE ${i} OR os ILIKE ${i})"
        )
    where = " WHERE " + " AND ".join(conditions)

    ob = order_by if order_by in SORTABLE_FIELDS else "serial_number"
    od = "DESC" if str(order).lower() == "desc" else "ASC"

    total = await pool.fetchval(f"SELECT count(*) FROM devices{where}", *params)
    params.append(limit)
    params.append(offset)
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM devices{where} "
        f"ORDER BY {ob} {od}, serial_number LIMIT ${len(params) - 1} OFFSET ${len(params)}",
        *params,
    )
    return [dict(r) for r in rows], total


async def get(pool: asyncpg.Pool, serial_number: str) -> dict | None:
    row = await pool.fetchrow(
        f"SELECT {COLUMNS} FROM devices WHERE serial_number = $1", serial_number
    )
    return dict(row) if row else None


async def update(
    pool: asyncpg.Pool, serial_number: str, device: DeviceUpdate
) -> dict | None:
    # Partial update: only touch the fields the client actually sent.
    fields = device.model_dump(exclude_unset=True)
    if not fields:
        # Nothing to change — return the current row (or None if missing).
        return await get(pool, serial_number)

    # Column names come from the Pydantic model (not user strings), so this is safe.
    cols = list(fields.keys())
    set_clause = ", ".join(f"{c} = ${i + 1}" for i, c in enumerate(cols))
    try:
        row = await pool.fetchrow(
            f"""UPDATE devices SET {set_clause}
                WHERE serial_number = ${len(cols) + 1}
                RETURNING {COLUMNS}""",
            *fields.values(), serial_number,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError("Barcode already in use") from e
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(f"Unknown user_id: {fields.get('user_id')}") from e
    return dict(row) if row else None


async def delete(pool: asyncpg.Pool, serial_number: str) -> bool:
    # Soft delete: move to trash (deleted_at set).
    result = await pool.execute(
        "UPDATE devices SET deleted_at = now() "
        "WHERE serial_number = $1 AND deleted_at IS NULL",
        serial_number,
    )
    return result != "UPDATE 0"


async def restore(pool: asyncpg.Pool, serial_number: str) -> bool:
    result = await pool.execute(
        "UPDATE devices SET deleted_at = NULL WHERE serial_number = $1", serial_number
    )
    return result != "UPDATE 0"


async def purge(pool: asyncpg.Pool, serial_number: str) -> bool:
    # Permanent delete (from the trash).
    result = await pool.execute(
        "DELETE FROM devices WHERE serial_number = $1", serial_number
    )
    return result != "DELETE 0"


async def delete_many(
    pool: asyncpg.Pool, serials: list[str], *, permanent: bool = False
) -> int:
    """Bulk delete. Soft-deletes (or purges) every serial in one round-trip.

    Lenient: unknown/already-gone serials are simply skipped. Returns the
    number of rows actually affected.
    """
    if not serials:
        return 0
    if permanent:
        result = await pool.execute(
            "DELETE FROM devices WHERE serial_number = ANY($1::text[])", serials
        )
    else:
        result = await pool.execute(
            "UPDATE devices SET deleted_at = now() "
            "WHERE serial_number = ANY($1::text[]) AND deleted_at IS NULL",
            serials,
        )
    return int(result.split()[-1])


async def import_devices(pool: asyncpg.Pool, devices: list[DeviceCreate]) -> dict:
    """Bulk import (from an uploaded xlsx/csv). Existing serials are skipped
    (ON CONFLICT DO NOTHING) so re-importing the same file is idempotent.
    Runs in a single transaction. Returns {inserted, skipped, total}."""
    inserted = 0
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                for device in devices:
                    row = await conn.fetchrow(
                        f"""INSERT INTO devices ({COLUMNS})
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                            ON CONFLICT (serial_number) DO NOTHING
                            RETURNING serial_number""",
                        device.serial_number, device.barcode, device.type,
                        device.brand, device.cpu, device.ram, device.storage,
                        device.os, device.msoffice, device.buy_date, device.name,
                        device.user_id, device.status,
                    )
                    if row is not None:
                        inserted += 1
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(
            "One or more rows reference an unknown owner (user_id). "
            "Leave the owner blank to import as unassigned."
        ) from e
    return {"inserted": inserted, "skipped": len(devices) - inserted,
            "total": len(devices)}


async def search(pool: asyncpg.Pool, q: str) -> list[dict]:
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM devices "
        f"WHERE deleted_at IS NULL AND (serial_number ILIKE $1 OR name ILIKE $1)",
        f"%{q}%",
    )
    return [dict(r) for r in rows]

FILTERABLE_FIELDS = frozenset({
    "type", "brand", "cpu", "ram", "storage", "os", "msoffice", "user_id", "status"
})


async def filter_devices(pool: asyncpg.Pool, field: str, value: str) -> list[dict]:
    """Filter devices by a single column. Column name is allowlisted — not user SQL."""
    if field not in FILTERABLE_FIELDS:
        raise ValueError(f"Unsupported filter field: {field}")
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM devices "
        f"WHERE {field} = $1 AND deleted_at IS NULL ORDER BY serial_number",
        value,
    )
    return [dict(r) for r in rows]