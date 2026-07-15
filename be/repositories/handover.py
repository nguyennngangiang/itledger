"""Handover data access. SQL lives here; the router stays thin.

asyncpg uses $1, $2 ... placeholders — never string-format user values into SQL.
"""
import asyncpg

from ..models.handover import HandoverCreate, HandoverUpdate
from .errors import DuplicateError, ForeignKeyError

COLUMNS = (
    "handover_id, handover_date, device_id, from_user_id, to_user_id, reason"
)


async def create(pool: asyncpg.Pool, handover: HandoverCreate) -> dict:
    try:
        row = await pool.fetchrow(
            f"""INSERT INTO handovers ({COLUMNS})
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING {COLUMNS}""",
            handover.handover_id,
            handover.handover_date,
            handover.device_id,
            handover.from_user_id,
            handover.to_user_id,
            handover.reason,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(
            f"Handover already exists: {handover.handover_id}"
        ) from e
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(
            f"Unknown device_id or user: "
            f"{handover.device_id}, {handover.from_user_id}, {handover.to_user_id}"
        ) from e
    return dict(row)


async def list_handovers(
    pool: asyncpg.Pool,
    device_id: str | None = None,
    from_user_id: str | None = None,
    to_user_id: str | None = None,
) -> list[dict]:
    conditions: list[str] = ["deleted_at IS NULL"]
    params: list[str] = []

    if device_id:
        params.append(device_id)
        conditions.append(f"device_id = ${len(params)}")
    if from_user_id:
        params.append(from_user_id)
        conditions.append(f"from_user_id = ${len(params)}")
    if to_user_id:
        params.append(to_user_id)
        conditions.append(f"to_user_id = ${len(params)}")

    where = f" WHERE {' AND '.join(conditions)}"
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM handovers{where} ORDER BY handover_id",
        *params,
    )
    return [dict(r) for r in rows]


SORTABLE_FIELDS = frozenset({
    "handover_id", "handover_date", "device_id", "from_user_id", "to_user_id",
})


async def list_page(
    pool: asyncpg.Pool,
    *,
    limit: int = 20,
    offset: int = 0,
    order_by: str = "handover_date",
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
            f"(device_id ILIKE ${i} OR from_user_id ILIKE ${i} "
            f"OR to_user_id ILIKE ${i} OR reason ILIKE ${i})"
        )
    where = " WHERE " + " AND ".join(conditions)
    ob = order_by if order_by in SORTABLE_FIELDS else "handover_date"
    od = "DESC" if str(order).lower() == "desc" else "ASC"

    total = await pool.fetchval(f"SELECT count(*) FROM handovers{where}", *params)
    params.append(limit)
    params.append(offset)
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM handovers{where} "
        f"ORDER BY {ob} {od}, handover_id LIMIT ${len(params) - 1} OFFSET ${len(params)}",
        *params,
    )
    return [dict(r) for r in rows], total


async def get(pool: asyncpg.Pool, handover_id: str) -> dict | None:
    row = await pool.fetchrow(
        f"SELECT {COLUMNS} FROM handovers WHERE handover_id = $1", handover_id
    )
    return dict(row) if row else None


async def update(
    pool: asyncpg.Pool, handover_id: str, handover: HandoverUpdate
) -> dict | None:
    fields = handover.model_dump(exclude_unset=True)
    if not fields:
        return await get(pool, handover_id)

    cols = list(fields.keys())
    set_clause = ", ".join(f"{c} = ${i + 1}" for i, c in enumerate(cols))
    try:
        row = await pool.fetchrow(
            f"""UPDATE handovers SET {set_clause}
                WHERE handover_id = ${len(cols) + 1}
                RETURNING {COLUMNS}""",
            *fields.values(),
            handover_id,
        )
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(
            f"Unknown device_id or user: "
            f"{fields.get('device_id')}, {fields.get('from_user_id')}, "
            f"{fields.get('to_user_id')}"
        ) from e
    return dict(row) if row else None


async def delete(pool: asyncpg.Pool, handover_id: str) -> bool:
    result = await pool.execute(
        "UPDATE handovers SET deleted_at = now() "
        "WHERE handover_id = $1 AND deleted_at IS NULL",
        handover_id,
    )
    return result != "UPDATE 0"


async def restore(pool: asyncpg.Pool, handover_id: str) -> bool:
    result = await pool.execute(
        "UPDATE handovers SET deleted_at = NULL WHERE handover_id = $1", handover_id
    )
    return result != "UPDATE 0"


async def purge(pool: asyncpg.Pool, handover_id: str) -> bool:
    result = await pool.execute(
        "DELETE FROM handovers WHERE handover_id = $1", handover_id
    )
    return result != "DELETE 0"


async def delete_many(
    pool: asyncpg.Pool, ids: list[str], *, permanent: bool = False
) -> int:
    """Bulk delete. Soft-deletes (or purges) every id in one round-trip.
    Lenient: unknown ids are skipped. Returns rows affected."""
    if not ids:
        return 0
    if permanent:
        result = await pool.execute(
            "DELETE FROM handovers WHERE handover_id = ANY($1::text[])", ids
        )
    else:
        result = await pool.execute(
            "UPDATE handovers SET deleted_at = now() "
            "WHERE handover_id = ANY($1::text[]) AND deleted_at IS NULL",
            ids,
        )
    return int(result.split()[-1])
