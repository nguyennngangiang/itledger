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
    conditions: list[str] = []
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

    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM handovers{where} ORDER BY handover_id",
        *params,
    )
    return [dict(r) for r in rows]


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
        "DELETE FROM handovers WHERE handover_id = $1", handover_id
    )
    return result != "DELETE 0"
