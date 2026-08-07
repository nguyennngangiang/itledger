"""Handover data access. SQL lives here; the router stays thin.

asyncpg uses $1, $2 ... placeholders — never string-format user values into SQL.
"""
import asyncpg

from ..constants import GHOST_CODE
from ..models.handover import HandoverCreate, HandoverUpdate
from . import _crud, owner_match
from .errors import DuplicateError, ForeignKeyError

COLUMNS = (
    "handover_id, handover_date, device_id, from_user_id, to_user_id, reason"
)

# Tie-break for two handovers of the same device on the same DATE.
#
# The date alone is not enough. A machine is very often collected and re-issued on
# the same day — someone hands their old laptop back and it goes straight out to
# the next person — and the two rows then tie. Breaking the tie on `handover_id`
# picks whichever id happens to sort later, which for 5CD410FW9R meant the
# "Return to IT" row won and the ledger showed IT holding a machine Vũ Thị Hồng Vân
# was actually using.
#
# Within a day the collection always precedes the hand-out: you cannot give away a
# machine you have not taken back yet. So the row whose destination is the store is
# the EARLIER event. In a newest-first list that means it comes last, hence ASC on
# the flag (false = 0 = went to a person = the later event = first).
# True when a row hands the machine to the IT side rather than out to a user.
#
# It deliberately does NOT just test `to_user_id = GHOST`. A return names the IT
# person who physically signed for it — that is the app's own convention, see
# handover_import.apply_flow, which records `to_user_id = it_code` while sending
# the DEVICE to the store. So "went back to IT" has to be read off the recipient's
# team, matching handover_import._looks_it: a token match, so "UNIT" and "AUDIT"
# do not count but "IT", "IT Support" and "TI + CI"'s neighbours do not either.
_TO_IT_SIDE = f"""(
    to_user_id = '{GHOST_CODE}' OR EXISTS (
        SELECT 1 FROM users u
        WHERE u.employee_code = handovers.to_user_id
          AND ' ' || replace(replace(lower(coalesce(u.team, '')), '/', ' '), '-', ' ')
              || ' ' LIKE '% it %'
    )
)"""


def _same_day(newest_first: bool) -> str:
    """Same-date tie-break, matching the direction of the date sort.

    The collection is the earlier event, so it sorts last when the list runs
    newest-first and first when it runs oldest-first — the flag's direction is
    always the inverse of the date's.
    """
    return f"{_TO_IT_SIDE} {'ASC' if newest_first else 'DESC'}"

# Newest first — for a device's history and for the import's flow decisions.
ORDER_NEWEST_FIRST = (
    f"ORDER BY handover_date DESC NULLS LAST, {_same_day(True)}, handover_id"
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


async def list_by_devices(
    pool: asyncpg.Pool, device_ids: list[str]
) -> dict[str, list[dict]]:
    """Every device's handovers in one query, keyed by serial.

    The importer's plan step needs each line item's history to work out which way
    the machine is moving. Asking per item made a twenty-row record twenty round
    trips, and importing a folder of records multiplied that — the same ordering
    as list_handovers, fetched once.
    """
    if not device_ids:
        return {}
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM handovers "
        f"WHERE deleted_at IS NULL AND device_id = ANY($1::varchar[]) "
        f"{ORDER_NEWEST_FIRST}",
        device_ids,
    )
    out: dict[str, list[dict]] = {d: [] for d in device_ids}
    for row in rows:
        out[row["device_id"]].append(dict(row))
    return out


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
    # Newest first, NOT by id: handover_id is a generated UUID (fe/src/lib/id.ts),
    # so ordering by it put a device's journey panel in essentially random order.
    # Same-day rows are separated by ORDER_NEWEST_FIRST's store rule, with the id
    # as the last resort.
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM handovers{where} {ORDER_NEWEST_FIRST}",
        *params,
    )
    return [dict(r) for r in rows]


SORTABLE_FIELDS = frozenset({
    "handover_id", "handover_date", "device_id", "from_user_id", "to_user_id",
})

# Columns offered as form autocomplete (see repositories.distinct_values). Only
# `reason` is free text here — the rest are ids picked from a list.
SUGGESTABLE_FIELDS = frozenset({"reason"})

# Nothing references handovers, so a purge here has no foreign key to trip and
# the default fk_message never fires.
TABLE = _crud.Table(
    name="handovers",
    pk="handover_id",
    columns=COLUMNS,
    sortable=SORTABLE_FIELDS,
    default_sort="handover_date",
    suggestable=SUGGESTABLE_FIELDS,
)


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
            f"(device_id ILIKE ${i} OR reason ILIKE ${i} "
            f"OR {owner_match('handovers.from_user_id', i)} "
            f"OR {owner_match('handovers.to_user_id', i)})"
        )
    where = " WHERE " + " AND ".join(conditions)
    ob = order_by if order_by in SORTABLE_FIELDS else "handover_date"
    od = "DESC" if str(order).lower() == "desc" else "ASC"

    total = await pool.fetchval(f"SELECT count(*) FROM handovers{where}", *params)
    params.append(limit)
    params.append(offset)
    # Sorting by date leaves same-day rows tied, so apply the same collect-then-
    # issue rule the device history uses; otherwise the table shows a machine
    # going back to the store *after* it was handed out. Only for a date sort —
    # the other columns are unique enough to order themselves.
    same_day = f"{_same_day(od == 'DESC')}, " if ob == "handover_date" else ""
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM handovers{where} "
        f"ORDER BY {ob} {od}, {same_day}handover_id "
        f"LIMIT ${len(params) - 1} OFFSET ${len(params)}",
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
    return await _crud.soft_delete(pool, TABLE, handover_id)


async def restore(pool: asyncpg.Pool, handover_id: str) -> bool:
    return await _crud.restore(pool, TABLE, handover_id)


async def purge(pool: asyncpg.Pool, handover_id: str) -> bool:
    return await _crud.purge(pool, TABLE, handover_id)


async def delete_many(
    pool: asyncpg.Pool, ids: list[str], *, permanent: bool = False
) -> int:
    return await _crud.delete_many(pool, TABLE, ids, permanent=permanent)
