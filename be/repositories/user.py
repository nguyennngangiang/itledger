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

from ..constants import GHOST_CODE
from ..models.user import UserCreate, UserUpdate
from . import _crud, distinct_values
from .errors import DuplicateError, ForeignKeyError, InUseError, ProtectedError

# Re-exported: import_employees.py and mark_leavers.py reach for it here.
__all__ = ["GHOST_CODE"]

COLUMNS = "employee_code, name, team, status"

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


# The ghost is not optional infrastructure — owner_for_status() writes IT-STORE
# into devices.user_id for anything under repair, so a database without this row
# rejects those writes on the FK. It used to be created only by be/seed.py, which
# means a fresh volume that was never seeded had a device API that failed on any
# maintaining/on_del status. Idempotent, so it is safe on every boot.
GHOST_DDL = """
INSERT INTO users (employee_code, name, team)
VALUES ('IT-STORE', 'IT Store', 'IT')
ON CONFLICT (employee_code) DO NOTHING;
"""


async def ensure_columns(pool: asyncpg.Pool) -> None:
    """Apply user-table column migrations to an already-running database."""
    await pool.execute(USER_MIGRATIONS_DDL)


async def ensure_ghost(pool: asyncpg.Pool) -> None:
    """Guarantee the IT-STORE row exists. See GHOST_DDL."""
    await pool.execute(GHOST_DDL)


async def create_batch(pool: asyncpg.Pool, users: list[UserCreate]) -> list[dict]:
    """All-or-nothing. A duplicate code on row 5 must not leave rows 1-4
    committed with no way for the caller to tell which landed."""
    rows = []
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                for user in users:
                    row = await conn.fetchrow(
                        f"""INSERT INTO users ({COLUMNS})
                            VALUES ($1,$2,$3,$4)
                            RETURNING {COLUMNS}""",
                        user.employee_code, user.name, user.team,
                        user.status or ACTIVE,
                    )
                    rows.append(dict(row))
    except asyncpg.UniqueViolationError as e:
        raise DuplicateError(f"User already exists: {user.employee_code}") from e
    return rows

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

# Only one column here is worth suggesting, but it still goes through the shared
# helper so teams get the same case-variant collapsing as device brands.
SUGGESTABLE_FIELDS = frozenset({"team"})

TABLE = _crud.Table(
    name="users",
    pk="employee_code",
    columns=COLUMNS,
    sortable=SORTABLE_FIELDS,
    default_sort="employee_code",
    suggestable=SUGGESTABLE_FIELDS,
    fk_message=(
        "{key} still appears in handover history and cannot be permanently "
        "deleted. Leave them in the trash instead."
    ),
    fk_message_many=(
        "One or more of those employees still appear in handover history and "
        "cannot be permanently deleted."
    ),
)


def _keyword(where: _crud.Where, q: str) -> None:
    """The free-text predicate, shared by list_page and search.

    unaccent on the Vietnamese text columns so "van" finds "Vân".
    """
    i = where.bind(f"%{q}%")
    where.add(
        f"(employee_code ILIKE ${i} OR unaccent(name) ILIKE unaccent(${i}) "
        f"OR unaccent(team) ILIKE unaccent(${i}))"
    )


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
    where = _crud.Where()
    where.live(deleted)
    where.add(f"employee_code <> ${where.bind(GHOST_CODE)}")
    if team:
        where.eq("team", team)
    if status in STATUSES:
        where.eq("status", status)
    # The 35 people the HR export has no record of arrived without a department,
    # and there is no source to fill them from — so the screen needs a way to find
    # them rather than scrolling 200 rows looking for blanks.
    if no_team:
        where.add("coalesce(btrim(team), '') = ''")
    if q:
        _keyword(where, q)
    return await _crud.paginate(
        pool, TABLE, where,
        limit=limit, offset=offset, order_by=order_by, order=order,
    )


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


# The guards stay here rather than moving into _crud: they are this resource's
# policy, not shared machinery, and the helper composes underneath them.
async def delete(pool: asyncpg.Pool, employee_code: str) -> bool:
    """Soft delete: move to trash (deleted_at set)."""
    await _guard_removable(pool, employee_code)
    return await _crud.soft_delete(pool, TABLE, employee_code)


async def restore(pool: asyncpg.Pool, employee_code: str) -> bool:
    return await _crud.restore(pool, TABLE, employee_code)


async def purge(pool: asyncpg.Pool, employee_code: str) -> bool:
    """Permanent delete (from the trash). Handovers still reference departed
    staff, so this can legitimately fail on a FK — reported as such."""
    await _guard_removable(pool, employee_code)
    return await _crud.purge(pool, TABLE, employee_code)


async def delete_many(
    pool: asyncpg.Pool, codes: list[str], *, permanent: bool = False
) -> int:
    """Bulk delete. Lenient about unknown codes, strict about the guards.

    The guard loop is why this is not a plain delegation: each code has to clear
    the ghost / still-owns-devices checks, and a caller who selected a protected
    row deserves to be told rather than have it silently skipped.
    """
    for code in codes:
        await _guard_removable(pool, code)
    return await _crud.delete_many(pool, TABLE, codes, permanent=permanent)


async def search(pool: asyncpg.Pool, q: str) -> list[dict]:
    where = _crud.Where()
    where.live(False)
    _keyword(where, q)
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM users{where.sql()}", *where.params
    )
    return [dict(r) for r in rows]


async def list_teams(pool: asyncpg.Pool) -> list[str]:
    """Team names actually in use — feeds the team autocomplete.

    There is no teams table (see be/seed.py); the real list lives in this
    column and grows as people are added, so read it rather than hardcode it.
    """
    return await distinct_values(pool, "users", "team", SUGGESTABLE_FIELDS)
