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
    "os, msoffice, buy_date, name, user_id"
)

async def create_batch(pool: asyncpg.Pool, devices: list[DeviceCreate]) -> list[dict]:
    try:
        rows = []
        for device in devices:
            row = await pool.fetchrow(
                f"""INSERT INTO devices ({COLUMNS})
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                    RETURNING {COLUMNS}""",
                device.serial_number, device.barcode, device.type, device.brand,
                device.cpu, device.ram, device.storage, device.os, device.msoffice,
                device.buy_date, device.name, device.user_id,
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
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                RETURNING {COLUMNS}""",
            device.serial_number, device.barcode, device.type, device.brand,
            device.cpu, device.ram, device.storage, device.os, device.msoffice,
            device.buy_date, device.name, device.user_id,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"Device already exists: {device.serial_number}") from e
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(f"Unknown user_id: {device.user_id}") from e
    return dict(row)


async def list_devices(pool: asyncpg.Pool, user_id: str | None = None) -> list[dict]:
    if user_id:
        rows = await pool.fetch(
            f"SELECT {COLUMNS} FROM devices WHERE user_id = $1 ORDER BY serial_number",
            user_id,
        )
    else:
        rows = await pool.fetch(f"SELECT {COLUMNS} FROM devices ORDER BY serial_number")
    return [dict(r) for r in rows]


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
    result = await pool.execute(
        "DELETE FROM devices WHERE serial_number = $1", serial_number
    )
    # asyncpg returns the command tag, e.g. "DELETE 1" / "DELETE 0".
    return result != "DELETE 0"
