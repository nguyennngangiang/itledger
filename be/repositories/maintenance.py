"""Maintenance data access. SQL lives here; the router stays thin.

asyncpg uses $1, $2 ... placeholders — never string-format user values into SQL.
"""
import asyncpg

from ..models.maintenance import MaintenanceCreate, MaintenanceUpdate
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


async def list_maintenance(
    pool: asyncpg.Pool,
    device_id: str | None = None,
    team: str | None = None,
) -> list[dict]:
    conditions: list[str] = []
    params: list[str] = []

    if device_id:
        params.append(device_id)
        conditions.append(f"device_id = ${len(params)}")
    if team:
        params.append(team)
        conditions.append(f"team = ${len(params)}")

    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM maintenance{where} ORDER BY maintenance_id",
        *params,
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
        "DELETE FROM maintenance WHERE maintenance_id = $1", maintenance_id
    )
    return result != "DELETE 0"
