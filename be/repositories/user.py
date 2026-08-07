"""User data access. SQL lives here; the router stays thin.

Follows the device repo template (repositories/device.py): soft delete via
`deleted_at`, an allow-listed ORDER BY, and domain errors instead of asyncpg
exceptions. Two things are specific to users, because four tables FK to this
one and nothing here cascades:

  * the IT-STORE ghost can never be removed — every ownerless device parks on it;
  * anyone still holding a device is refused up front, with the count, rather
    than being soft-deleted into a state where the device points at a person
    who is no longer in the list.
"""
import asyncpg

from ..models.user import UserCreate, UserUpdate
from . import distinct_values
from .errors import DuplicateError, ForeignKeyError, InUseError, ProtectedError

COLUMNS = "employee_code, name, team, status"

# The single ghost account that owns every ownerless / in-stock device.
# Mirrors GHOST_USER_CODE in fe/src/types.ts and GHOST_CODE in be/seed.py.
GHOST_CODE = "IT-STORE"

ACTIVE = "active"
RETIRED = "retired"
STATUSES = frozenset({ACTIVE, RETIRED})

# Applied here rather than only in schema.sql so a live database picks these up on
# restart (see main.py lifespan).
#
# `position` is dropped: two rows out of 235 ever had one, and the field invited
# exactly the confusion it was meant to prevent — VPHN228's job title "IT" sat in
# `position` while his `team` read "Operation", so the importer could not tell he
# was the IT side. His team now says IT, which is what everything else reads.
USER_MIGRATIONS_DDL = """
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active';
UPDATE users SET status = 'active' WHERE status IS NULL;
ALTER TABLE users DROP COLUMN IF EXISTS position;
"""


async def ensure_columns(pool: asyncpg.Pool) -> None:
    """Apply user-table column migrations to an already-running database."""
    await pool.execute(USER_MIGRATIONS_DDL)


async def create_batch(pool: asyncpg.Pool, users: list[UserCreate]) -> list[dict]:
    try:
        rows = []
        for user in users:
            row = await pool.fetchrow(
                f"""INSERT INTO users ({COLUMNS})
                    VALUES ($1,$2,$3,$4)
                    RETURNING {COLUMNS}""",
                user.employee_code, user.name, user.team, user.status or ACTIVE,
            )
            rows.append(dict(row))
        return rows
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"User already exists: {user.employee_code}") from e

async def create(pool: asyncpg.Pool, user: UserCreate) -> dict:
    try:
        row = await pool.fetchrow(
            f"""INSERT INTO users ({COLUMNS})
                VALUES ($1, $2, $3, $4)
                RETURNING {COLUMNS}""",
            user.employee_code, user.name, user.team, user.status or ACTIVE,
        )
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"User already exists: {user.employee_code}") from e
    return dict(row)


async def list_users(
    pool: asyncpg.Pool, team: str | None = None, include_deleted: bool = False
) -> list[dict]:
    """Reference-data fetch. Excludes soft-deleted rows by default.

    `include_deleted` exists for the screens' *display* lookup maps: a handover
    recorded years ago still names whoever held the device, and once that person
    is trashed the row would fall back to showing a bare employee code. History
    should keep reading as history. Owner *pickers* leave this off — nobody
    should be able to hand a device to someone who has left.
    """
    conditions = [] if include_deleted else ["deleted_at IS NULL"]
    params: list = []
    if team:
        params.append(team)
        conditions.append(f"team = ${len(params)}")
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM users{where} ORDER BY employee_code", *params
    )
    return [dict(r) for r in rows]


# Columns allowed in ORDER BY (name is interpolated, so it MUST be allowlisted).
SORTABLE_FIELDS = frozenset({"employee_code", "name", "team", "status"})


async def list_page(
    pool: asyncpg.Pool,
    *,
    limit: int = 20,
    offset: int = 0,
    order_by: str = "employee_code",
    order: str = "asc",
    deleted: bool = False,
    q: str | None = None,
    team: str | None = None,
    status: str | None = None,
    no_team: bool = False,
) -> tuple[list[dict], int]:
    """Paginated + sortable + searchable staff list. Returns (rows, total).

    The IT-STORE ghost is never in it. This backs the Employees screen, and the
    ghost is not an employee — it is the account ownerless devices park on. It
    stays in list_users() because the owner pickers and the name lookup maps do
    need it; it is only hidden from the list of people. Excluding it here rather
    than in the UI keeps `total` and the pagination honest.
    """
    params: list = [GHOST_CODE]
    conditions = [
        "deleted_at IS NOT NULL" if deleted else "deleted_at IS NULL",
        "employee_code <> $1",
    ]
    if team:
        params.append(team)
        conditions.append(f"team = ${len(params)}")
    if status in STATUSES:
        params.append(status)
        conditions.append(f"status = ${len(params)}")
    # The 35 people the HR export has no record of arrived without a department,
    # and there is no source to fill them from — so the screen needs a way to find
    # them rather than scrolling 200 rows looking for blanks.
    if no_team:
        conditions.append("coalesce(btrim(team), '') = ''")
    if q:
        params.append(f"%{q}%")
        i = len(params)
        # unaccent on the Vietnamese text columns so "van" finds "Vân".
        conditions.append(
            f"(employee_code ILIKE ${i} OR unaccent(name) ILIKE unaccent(${i}) "
            f"OR unaccent(team) ILIKE unaccent(${i}))"
        )
    where = " WHERE " + " AND ".join(conditions)

    ob = order_by if order_by in SORTABLE_FIELDS else "employee_code"
    od = "DESC" if str(order).lower() == "desc" else "ASC"

    total = await pool.fetchval(f"SELECT count(*) FROM users{where}", *params)
    params.append(limit)
    params.append(offset)
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM users{where} "
        f"ORDER BY {ob} {od}, employee_code "
        f"LIMIT ${len(params) - 1} OFFSET ${len(params)}",
        *params,
    )
    return [dict(r) for r in rows], total


async def get(pool: asyncpg.Pool, employee_code: str) -> dict | None:
    row = await pool.fetchrow(
        f"SELECT {COLUMNS} FROM users WHERE employee_code = $1", employee_code
    )
    return dict(row) if row else None


async def update(
    pool: asyncpg.Pool, employee_code: str, user: UserUpdate
) -> dict | None:
    # The ghost's name and team are structural — "IT Store" is what the app
    # prints for every unassigned device. Renaming it is never intended.
    if employee_code == GHOST_CODE:
        raise ProtectedError(f"{GHOST_CODE} is the in-stock account and cannot be edited.")
    fields = user.model_dump(exclude_unset=True)
    if not fields:
        return await get(pool, employee_code)

    # Column names come from the Pydantic model (not user strings), so this is safe.
    cols = list(fields.keys())
    set_clause = ", ".join(f"{c} = ${i + 1}" for i, c in enumerate(cols))
    row = await pool.fetchrow(
        f"""UPDATE users SET {set_clause}
            WHERE employee_code = ${len(cols) + 1}
            RETURNING {COLUMNS}""",
        *fields.values(), employee_code,
    )
    return dict(row) if row else None


async def count_owned_devices(pool: asyncpg.Pool, employee_code: str) -> int:
    """How many live devices still name this person as their owner."""
    return await pool.fetchval(
        "SELECT count(*) FROM devices WHERE user_id = $1 AND deleted_at IS NULL",
        employee_code,
    )


async def _guard_removable(pool: asyncpg.Pool, employee_code: str) -> None:
    """Refuse to remove the ghost, or anyone still holding devices."""
    if employee_code == GHOST_CODE:
        raise ProtectedError(
            f"{GHOST_CODE} is the in-stock account and cannot be deleted."
        )
    owned = await count_owned_devices(pool, employee_code)
    if owned:
        raise InUseError(
            f"{employee_code} still owns {owned} device(s). "
            f"Hand them over (or move them to IT-STORE) first."
        )


async def delete(pool: asyncpg.Pool, employee_code: str) -> bool:
    # Soft delete: move to trash (deleted_at set).
    await _guard_removable(pool, employee_code)
    result = await pool.execute(
        "UPDATE users SET deleted_at = now() "
        "WHERE employee_code = $1 AND deleted_at IS NULL",
        employee_code,
    )
    return result != "UPDATE 0"


async def restore(pool: asyncpg.Pool, employee_code: str) -> bool:
    result = await pool.execute(
        "UPDATE users SET deleted_at = NULL WHERE employee_code = $1", employee_code
    )
    return result != "UPDATE 0"


async def purge(pool: asyncpg.Pool, employee_code: str) -> bool:
    # Permanent delete (from the trash). Handovers still reference departed
    # staff, so this can legitimately fail on a FK — report it as such.
    await _guard_removable(pool, employee_code)
    try:
        result = await pool.execute(
            "DELETE FROM users WHERE employee_code = $1", employee_code
        )
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(
            f"{employee_code} still appears in handover history and cannot be "
            f"permanently deleted. Leave them in the trash instead."
        ) from e
    return result != "DELETE 0"


async def delete_many(
    pool: asyncpg.Pool, codes: list[str], *, permanent: bool = False
) -> int:
    """Bulk delete. Lenient about unknown codes, strict about the guards.

    Unlike the device repo this cannot be a single round-trip: each code has to
    clear the ghost / still-owns-devices checks, and a caller who selected a
    protected row deserves to be told rather than have it silently skipped.
    """
    if not codes:
        return 0
    for code in codes:
        await _guard_removable(pool, code)
    if permanent:
        try:
            result = await pool.execute(
                "DELETE FROM users WHERE employee_code = ANY($1::text[])", codes
            )
        except asyncpg.ForeignKeyViolationError as e:
            raise ForeignKeyError(
                "One or more of those employees still appear in handover history "
                "and cannot be permanently deleted."
            ) from e
    else:
        result = await pool.execute(
            "UPDATE users SET deleted_at = now() "
            "WHERE employee_code = ANY($1::text[]) AND deleted_at IS NULL",
            codes,
        )
    return int(result.split()[-1])


async def search(pool: asyncpg.Pool, q: str) -> list[dict]:
    pattern = f"%{q}%"
    rows = await pool.fetch(
        f"""SELECT {COLUMNS} FROM users
            WHERE deleted_at IS NULL
              AND (employee_code ILIKE $1
               OR unaccent(name) ILIKE unaccent($1)
               OR unaccent(team) ILIKE unaccent($1))""",
        pattern,
    )
    return [dict(r) for r in rows]


# Only one column here is worth suggesting, but go through the shared helper so
# teams get the same case-variant collapsing as device brands.
SUGGESTABLE_FIELDS = frozenset({"team"})


async def list_teams(pool: asyncpg.Pool) -> list[str]:
    """Team names actually in use — feeds the team autocomplete.

    There is no teams table (see be/seed.py); the real list lives in this
    column and grows as people are added, so read it rather than hardcode it.
    """
    return await distinct_values(pool, "users", "team", SUGGESTABLE_FIELDS)
