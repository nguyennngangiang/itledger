"""User data access. SQL lives here; the router stays thin."""
import asyncpg

from ..models.user import UserCreate, UserUpdate
from .errors import DuplicateError, ForeignKeyError

COLUMNS = "employee_code, name, team"

async def create_batch(pool: asyncpg.Pool, users: list[UserCreate]) -> list[dict]:
    try:
        rows = []
        for user in users:
            row = await pool.fetchrow(
                f"""INSERT INTO users ({COLUMNS})
                    VALUES ($1,$2,$3)
                    RETURNING {COLUMNS}""",
                user.employee_code, user.name, user.team,
            )
            rows.append(dict(row))
        return rows
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"User already exists: {user.employee_code}") from e
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(f"Unknown team: {user.team}") from e

async def create(pool: asyncpg.Pool, user: UserCreate) -> dict:
    try:
        row = await pool.fetchrow(
            f"""INSERT INTO users ({COLUMNS})
                VALUES ($1, $2, $3)
                RETURNING {COLUMNS}""",
            user.employee_code, user.name, user.team,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"User already exists: {user.employee_code}") from e
    # except asyncpg.ForeignKeyViolationError as e:
    #     raise ForeignKeyError(f"Unknown team: {user.team}") from e
    return dict(row)


async def list_users(pool: asyncpg.Pool, team: str | None = None) -> list[dict]:
    if team:
        rows = await pool.fetch(
            f"SELECT {COLUMNS} FROM users WHERE team = $1 ORDER BY employee_code",
            team,
        )
    else:
        rows = await pool.fetch(f"SELECT {COLUMNS} FROM users ORDER BY employee_code")
    return [dict(r) for r in rows]


async def get(pool: asyncpg.Pool, employee_code: str) -> dict | None:
    row = await pool.fetchrow(
        f"SELECT {COLUMNS} FROM users WHERE employee_code = $1", employee_code
    )
    return dict(row) if row else None


async def update(
    pool: asyncpg.Pool, employee_code: str, user: UserUpdate
) -> dict | None:
    fields = user.model_dump(exclude_unset=True)
    if not fields:
        return await get(pool, employee_code)

    cols = list(fields.keys())
    set_clause = ", ".join(f"{c} = ${i + 1}" for i, c in enumerate(cols))
    try:
        row = await pool.fetchrow(
            f"""UPDATE users SET {set_clause}
                WHERE employee_code = ${len(cols) + 1}
                RETURNING {COLUMNS}""",
            *fields.values(), employee_code,
        )
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(f"Unknown team: {fields.get('team')}") from e
    return dict(row) if row else None


async def delete(pool: asyncpg.Pool, employee_code: str) -> bool:
    result = await pool.execute(
        "DELETE FROM users WHERE employee_code = $1", employee_code
    )
    return result != "DELETE 0"

async def search(pool: asyncpg.Pool, q: str) -> list[dict]:
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM users WHERE employee_code LIKE $1 OR name LIKE $1 OR team LIKE $1",
        f"%{q}%",
    )
    return [dict(r) for r in rows]
