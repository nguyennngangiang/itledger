"""The soft-delete/trash machinery every resource shares.

Four repositories each carried their own `delete` / `restore` / `purge` /
`delete_many`, differing only in the table name and the primary-key column —
twelve functions and three byte-identical bodies that were one function wearing
four hats, plus `int(result.split()[-1])` written out a dozen times.

## The security boundary

Table and column names cannot be passed as asyncpg `$n` parameters, so they are
interpolated. That is a real hazard and it is contained in four layers:

1. **One gate.** Every string that ever reaches an f-string as an identifier
   goes through `_ident()`.
2. **Import time, not request time.** `Table` validates in `__post_init__`, so a
   bad literal is a module-import crash — it fails at pytest collection, not in
   production.
3. **Request values are matched, never forwarded.** An `order_by` off the query
   string is only ever used as `x if x in spec.sortable else spec.default_sort`.
   On a miss it is *replaced*, so it never reaches SQL as itself.
4. **Belt and braces.** `paginate()` re-checks the column it is about to format
   even though membership of a validated frozenset already guarantees it.

The invariant that keeps this true, and the thing to preserve in review:
**no function in this module accepts a bare identifier `str` from a caller.**
Identifiers arrive only as `Table` fields or as members of a `Table`-validated
allowlist. User values arrive only through `Where.bind()`.
"""
import re
from collections.abc import Callable
from dataclasses import dataclass

import asyncpg

from .errors import ForeignKeyError

# Unquoted lowercase SQL identifiers only. Postgres truncates at 63 bytes, so
# anything longer is a mistake rather than a name.
_IDENT = re.compile(r"\A[a-z_][a-z0-9_]{0,62}\Z")


def _ident(name: str) -> str:
    """The single gate. Returns the name, or refuses to let it near an f-string."""
    if not _IDENT.match(name):
        raise ValueError(f"Not a safe SQL identifier: {name!r}")
    return name


@dataclass(frozen=True)
class Table:
    """The SQL identifiers for one soft-deletable resource.

    Built at import time from literals in the repository modules, so the
    validation below runs once at startup rather than per request.
    """

    name: str
    pk: str
    columns: str  # the shared SELECT / RETURNING list, comma separated
    sortable: frozenset[str]
    default_sort: str
    suggestable: frozenset[str] = frozenset()
    # Shown when a purge is refused by a foreign key. `{key}` is the id.
    fk_message: str = "{key} is still referenced and cannot be permanently deleted."
    fk_message_many: str = (
        "One or more of those rows are still referenced and cannot be "
        "permanently deleted."
    )

    def __post_init__(self) -> None:
        _ident(self.name)
        _ident(self.pk)
        _ident(self.default_sort)
        for column in self.sortable | self.suggestable:
            _ident(column)
        # `columns` is a comma-list rather than one identifier, so check each part.
        for column in self.columns.split(","):
            _ident(column.strip())
        if self.default_sort not in self.sortable:
            raise ValueError(
                f"{self.name}: default_sort {self.default_sort!r} is not in sortable"
            )


class Where:
    """Accumulates conditions and the values they bind to.

    Not a query builder — it does not know what a table or a JOIN is. Callers
    write SQL fragments from module-level literals and ask `bind()` for the
    placeholder index to put in them, which is the half that was duplicated:
    every list_page open-coded `params.append(x); i = len(params)` and then
    `LIMIT ${len(params) - 1} OFFSET ${len(params)}`, four times, with the count
    query depending on running before the limit was appended.

    User values reach SQL only through bind(). They never appear in a fragment.
    """

    def __init__(self) -> None:
        self.conditions: list[str] = []
        self.params: list = []

    def bind(self, value) -> int:
        """Register a value and return its $n index."""
        self.params.append(value)
        return len(self.params)

    def add(self, sql: str) -> None:
        """Add a condition. `sql` must come from a literal, not from user input."""
        self.conditions.append(sql)

    def eq(self, column: str, value) -> None:
        self.add(f"{_ident(column)} = ${self.bind(value)}")

    def live(self, deleted: bool) -> None:
        """Trash filter: the trash view when `deleted`, otherwise active rows."""
        self.add("deleted_at IS NOT NULL" if deleted else "deleted_at IS NULL")

    def sql(self) -> str:
        return (" WHERE " + " AND ".join(self.conditions)) if self.conditions else ""


async def paginate(
    pool: asyncpg.Pool,
    spec: Table,
    where: Where,
    *,
    limit: int,
    offset: int,
    order_by: str,
    order: str,
    tie_break: Callable[[str, str], str] | None = None,
) -> tuple[list[dict], int]:
    """One page plus the unpaged total, for an already-built Where.

    `order_by` arrives from the query string: it is matched against the
    allowlist and REPLACED on a miss, never rejected-then-used, so it cannot
    reach SQL as itself. The pk is always appended as the final tie-break so
    paging is stable when the sort column has duplicates.

    `tie_break` lets a resource inject its own middle tie-break, given the
    resolved (column, direction). Handovers use it for same-day ordering; the
    helper only decides where the fragment goes, and knows nothing about it.
    """
    column = _ident(order_by if order_by in spec.sortable else spec.default_sort)
    direction = "DESC" if str(order).lower() == "desc" else "ASC"
    clause = where.sql()

    # Snapshot before binding limit/offset. The old code relied on the count
    # query simply running before those were appended, which was true but broke
    # the moment anyone reordered two lines.
    count_params = list(where.params)
    total = await pool.fetchval(
        f"SELECT count(*) FROM {spec.name}{clause}", *count_params
    )

    fragment = tie_break(column, direction) if tie_break else ""
    middle = f"{fragment}, " if fragment else ""
    limit_at, offset_at = where.bind(limit), where.bind(offset)
    rows = await pool.fetch(
        f"SELECT {spec.columns} FROM {spec.name}{clause} "
        f"ORDER BY {column} {direction}, {middle}{spec.pk} "
        f"LIMIT ${limit_at} OFFSET ${offset_at}",
        *where.params,
    )
    return [dict(r) for r in rows], total


async def soft_delete(pool: asyncpg.Pool, spec: Table, key: str) -> bool:
    """Move a row to the trash. False if there was no live row to move."""
    result = await pool.execute(
        f"UPDATE {spec.name} SET deleted_at = now() "
        f"WHERE {spec.pk} = $1 AND deleted_at IS NULL",
        key,
    )
    return result != "UPDATE 0"


async def restore(pool: asyncpg.Pool, spec: Table, key: str) -> bool:
    """Bring a row back from the trash.

    Deliberately NOT symmetric with soft_delete: there is no
    `AND deleted_at IS NOT NULL` guard, so restoring a row that was never in the
    trash succeeds as a no-op rather than reporting False. Adding the guard would
    turn that into a `404 not found` for a row that plainly exists, which is a
    worse answer. The UI only offers restore from the trash view, so neither
    path is reachable in practice — this is about which lie is less confusing
    when something does reach it.
    """
    result = await pool.execute(
        f"UPDATE {spec.name} SET deleted_at = NULL WHERE {spec.pk} = $1", key
    )
    return result != "UPDATE 0"


async def purge(pool: asyncpg.Pool, spec: Table, key: str) -> bool:
    """Permanently delete a row. Raises ForeignKeyError if it is still referenced."""
    try:
        result = await pool.execute(
            f"DELETE FROM {spec.name} WHERE {spec.pk} = $1", key
        )
    except asyncpg.ForeignKeyViolationError as e:
        raise ForeignKeyError(spec.fk_message.format(key=key)) from e
    return result != "DELETE 0"


async def delete_many(
    pool: asyncpg.Pool, spec: Table, keys: list[str], *, permanent: bool = False
) -> int:
    """Bulk delete in one round-trip. Lenient: unknown keys are skipped.

    Returns the number of rows actually affected. A foreign key refuses the
    whole batch rather than half-applying it — it is a single statement, so that
    is what the database does anyway.
    """
    if not keys:
        return 0
    if permanent:
        try:
            result = await pool.execute(
                f"DELETE FROM {spec.name} WHERE {spec.pk} = ANY($1::text[])", keys
            )
        except asyncpg.ForeignKeyViolationError as e:
            raise ForeignKeyError(spec.fk_message_many) from e
    else:
        result = await pool.execute(
            f"UPDATE {spec.name} SET deleted_at = now() "
            f"WHERE {spec.pk} = ANY($1::text[]) AND deleted_at IS NULL",
            keys,
        )
    return int(result.split()[-1])
