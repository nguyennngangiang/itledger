"""Device data access. SQL lives here; the router stays thin.

This is the template to clone for user / handover / maintenance repos.
asyncpg uses $1, $2 ... placeholders — never string-format user values into SQL.
"""
import asyncpg

from ..models.device import DeviceCreate, DeviceUpdate
from . import owner_match
from .errors import DuplicateError, ForeignKeyError

# Shared column list so SELECT / RETURNING always match the DeviceOut shape.
COLUMNS = (
    "serial_number, barcode, type, brand, cpu, ram, storage, "
    "os, msoffice, buy_date, name, user_id, status"
)

# The ghost account that holds anything nobody is using. Mirrors GHOST_CODE in
# repositories/user.py and GHOST_USER_CODE in fe/src/types.ts.
GHOST_CODE = "IT-STORE"
# Statuses that mean IT is physically holding the machine, so no person can be
# its owner. The active/in_stock pair is only auto-filled in the UI and stays
# editable; THIS one is a rule, enforced here so an import or a direct API call
# cannot leave a device under repair sitting on someone's name.
IT_HELD_STATUSES = frozenset({"maintaining", "on_del"})


def owner_for_status(status: str | None, user_id: str | None) -> str | None:
    """IT-STORE owns whatever is being repaired or written off."""
    return GHOST_CODE if status in IT_HELD_STATUSES else user_id

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
    owner = owner_for_status(device.status, device.user_id)
    try:
        row = await pool.fetchrow(
            f"""INSERT INTO devices ({COLUMNS})
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                RETURNING {COLUMNS}""",
            device.serial_number, device.barcode, device.type, device.brand,
            device.cpu, device.ram, device.storage, device.os, device.msoffice,
            device.buy_date, device.name, owner, device.status,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"Device already exists: {device.serial_number}") from e
    except asyncpg.ForeignKeyViolationError as e:
        # `owner`, not device.user_id: for an IT-held status owner_for_status
        # substitutes the ghost, so a caller who sent no owner at all would
        # otherwise be told "Unknown user_id: None" about a code they never sent.
        raise ForeignKeyError(f"Unknown user_id: {owner}") from e
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
            f"(serial_number ILIKE ${i} OR unaccent(name) ILIKE unaccent(${i}) "
            f"OR unaccent(brand) ILIKE unaccent(${i}) OR os ILIKE ${i} "
            f"OR {owner_match('devices.user_id', i)})"
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


async def get_many(pool: asyncpg.Pool, serial_numbers: list[str]) -> dict[str, dict]:
    """Devices by serial in one query, keyed by serial; missing serials are absent.

    Deleted rows are included on purpose — `get` returns them too, and the importer
    reconciling a line item needs to know the serial exists at all.
    """
    if not serial_numbers:
        return {}
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM devices WHERE serial_number = ANY($1::varchar[])",
        serial_numbers,
    )
    return {r["serial_number"]: dict(r) for r in rows}


async def update(
    pool: asyncpg.Pool, serial_number: str, device: DeviceUpdate
) -> dict | None:
    # Partial update: only touch the fields the client actually sent.
    fields = device.model_dump(exclude_unset=True)
    if not fields:
        # Nothing to change — return the current row (or None if missing).
        return await get(pool, serial_number)

    # Reconcile owner and status against each other. A PATCH may carry either
    # one alone, so the missing half comes from the stored row: setting status
    # to maintaining moves the device to IT-STORE even though the caller said
    # nothing about the owner.
    if "status" in fields or "user_id" in fields:
        current = await get(pool, serial_number)
        if current is None:
            return None
        status = fields.get("status", current["status"])
        user_id = fields.get("user_id", current["user_id"])
        owner = owner_for_status(status, user_id)
        if owner != user_id:
            fields["user_id"] = owner

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


# Handovers and maintenance rows both FK to devices.serial_number and nothing
# cascades, so purging a device that has any history is a constraint violation.
# That is most of the fleet — the ledger exists to accumulate exactly that
# history — so this is the normal case, not the edge case, and it has to read as
# a refusal rather than a crash.
_PURGE_BLOCKED = (
    "{key} still appears in handover or repair history and cannot be "
    "permanently deleted. Leave it in the trash instead."
)


async def purge(pool: asyncpg.Pool, serial_number: str) -> bool:
    # Permanent delete (from the trash).
    try:
        result = await pool.execute(
            "DELETE FROM devices WHERE serial_number = $1", serial_number
        )
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(_PURGE_BLOCKED.format(key=serial_number)) from e
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
        try:
            result = await pool.execute(
                "DELETE FROM devices WHERE serial_number = ANY($1::text[])", serials
            )
        except asyncpg.ForeignKeyViolationError as e:
            # One statement, so the whole batch is refused rather than partly
            # applied. Which serial tripped it is not worth a second query —
            # the fix is the same for all of them.
            raise ForeignKeyError(
                "One or more of those devices still appear in handover or repair "
                "history and cannot be permanently deleted."
            ) from e
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
    # Also backs the assistant's find_devices tool, so Ask AI can look a machine
    # up by who holds it, not just by serial.
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM devices "
        f"WHERE deleted_at IS NULL AND (serial_number ILIKE $1 "
        f"OR unaccent(name) ILIKE unaccent($1) "
        f"OR {owner_match('devices.user_id', 1)})",
        f"%{q}%",
    )
    return [dict(r) for r in rows]

FILTERABLE_FIELDS = frozenset({
    "type", "brand", "cpu", "ram", "storage", "os", "msoffice", "user_id", "status"
})

# Columns offered as form autocomplete (see repositories.distinct_values).
# Deliberately not FILTERABLE_FIELDS: `name` is worth suggesting but filtering
# on an exact device name is useless, and suggesting user_id/status makes no
# sense when both already have proper pickers.
SUGGESTABLE_FIELDS = frozenset({
    "type", "brand", "cpu", "ram", "storage", "os", "msoffice", "name"
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