"""Import-issue data access. SQL lives here; the router stays thin.

Every row is one thing the handover-minutes importer could not decide on its own
and a human still has to rule on: a person who exists under a different employee
code, a field that disagrees with the workbook, a device created with only the
half of its spec the minutes carried, a handover that looks like one already in
the ledger. The importer never silently picks a side — it writes the disagreement
here and the Notifications screen works through the backlog.

`payload` is free-form JSONB because each `kind` needs a different shape (a field
conflict carries a field list, a code mismatch carries candidate people); the
frontend renders per kind. asyncpg has no implicit dict→jsonb codec, so payloads
are json.dumps'd and cast with `$n::jsonb` on the way in and json.loads'd on the
way out — see `_row()`.

No FK to users/devices/handovers: an issue about a row that was later deleted is
still worth reading, and the item it names may not exist yet at all.
"""
import json

import asyncpg

COLUMNS = (
    "id, created_at, source_file, kind, resource, item_id, payload, "
    "status, resolved_at, resolution"
)

# Every issue kind the importer can raise. Allow-listed because `kind` drives
# which editor the frontend opens, and an unknown kind would render as a dead row.
KINDS = frozenset({
    # No longer raised: creating a person the minutes name is the outcome, not a
    # decision left pending. Kept so rows written before that change still render.
    "user_created",
    "user_code_mismatch",        # same name already exists under another employee code
    "user_field_conflict",       # name / team / position disagree with the minutes
    "device_created_incomplete", # device created from the minutes; specs still missing
    "device_field_conflict",     # stored specs disagree with the minutes
    "device_owner_mismatch",     # device is held by someone not named in the minutes
    "handover_duplicate",        # a handover for this device + pair already exists
    "flow_ambiguous",            # return vs hand-out could not be decided
})

OPEN = "open"
RESOLVED = "resolved"
DISMISSED = "dismissed"
STATUSES = frozenset({OPEN, RESOLVED, DISMISSED})

IMPORT_ISSUES_DDL = """
CREATE TABLE IF NOT EXISTS import_issues (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    source_file VARCHAR(255),
    kind VARCHAR(40) NOT NULL,
    resource VARCHAR(16) NOT NULL DEFAULT 'handovers',
    item_id VARCHAR(100),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    resolved_at TIMESTAMP,
    resolution JSONB
);
CREATE INDEX IF NOT EXISTS idx_import_issues_open
    ON import_issues (status, created_at DESC);
"""


# IMPORT_ISSUES_DDL is applied at startup by be/migrations.py.


def _row(row: asyncpg.Record) -> dict:
    """Record → dict with the JSONB columns decoded."""
    out = dict(row)
    for key in ("payload", "resolution"):
        raw = out.get(key)
        if isinstance(raw, str):
            try:
                out[key] = json.loads(raw)
            except json.JSONDecodeError:
                out[key] = None
    return out


async def create_many(
    conn: asyncpg.Connection | asyncpg.Pool, issues: list[dict]
) -> list[dict]:
    """Record a batch of unresolved disagreements.

    Takes a connection (not just a pool) so the importer can write these inside
    the same transaction as the rows they describe: an issue pointing at a device
    that was rolled back would be a lie.

    Unknown `kind` values are refused rather than stored — see KINDS.

    An issue already open for the same (kind, resource, item_id) is not written
    again: re-importing a record the team has not got to yet is normal, and the
    same disagreement listed four times reads as four jobs. A partial unique index
    would be the tidier guard, but the live table already holds duplicates from
    before this check, so it is enforced here instead of by DDL that cannot build.
    """
    if not issues:
        return []
    rows = []
    for issue in issues:
        kind = issue.get("kind")
        if kind not in KINDS:
            raise ValueError(f"Unknown import issue kind: {kind}")
        resource = issue.get("resource") or "handovers"
        already = await conn.fetchval(
            """SELECT 1 FROM import_issues
                WHERE status = $1 AND kind = $2 AND resource = $3
                  AND item_id IS NOT DISTINCT FROM $4
                LIMIT 1""",
            OPEN, kind, resource, issue.get("item_id"),
        )
        if already:
            continue
        row = await conn.fetchrow(
            f"""INSERT INTO import_issues
                    (source_file, kind, resource, item_id, payload)
                VALUES ($1, $2, $3, $4, $5::jsonb)
                RETURNING {COLUMNS}""",
            issue.get("source_file"),
            kind,
            resource,
            issue.get("item_id"),
            json.dumps(issue.get("payload") or {}, default=str),
        )
        rows.append(_row(row))
    return rows


async def list_issues(
    pool: asyncpg.Pool, *, status: str | None = OPEN, limit: int = 200
) -> list[dict]:
    """Issues newest-first. `status=None` returns every state (the full log)."""
    params: list = []
    where = ""
    if status:
        if status not in STATUSES:
            raise ValueError(f"Unsupported status: {status}")
        params.append(status)
        where = " WHERE status = $1"
    params.append(limit)
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM import_issues{where} "
        f"ORDER BY created_at DESC, id DESC LIMIT ${len(params)}",
        *params,
    )
    return [_row(r) for r in rows]


async def count_open(pool: asyncpg.Pool) -> int:
    """Backs the nav badge."""
    return await pool.fetchval(
        "SELECT count(*) FROM import_issues WHERE status = $1", OPEN
    )


async def get(pool: asyncpg.Pool, issue_id: int) -> dict | None:
    row = await pool.fetchrow(
        f"SELECT {COLUMNS} FROM import_issues WHERE id = $1", issue_id
    )
    return _row(row) if row else None


async def update_payload(
    pool: asyncpg.Pool, issue_id: int, payload: dict
) -> dict | None:
    """Rewrite an open issue's payload in place.

    Used by the recheck pass: a device that gained two of its four missing fields
    is still incomplete, but the row should say which two are left rather than
    keep repeating the list it was written with.
    """
    row = await pool.fetchrow(
        f"""UPDATE import_issues SET payload = $1::jsonb
            WHERE id = $2 RETURNING {COLUMNS}""",
        json.dumps(payload, default=str),
        issue_id,
    )
    return _row(row) if row else None


async def set_status(
    pool: asyncpg.Pool,
    issue_id: int,
    status: str,
    resolution: dict | None = None,
) -> dict | None:
    """Close an issue as resolved (with what the human chose) or dismissed.

    `resolution` is kept even when dismissing: knowing an issue was waved through,
    and by which decision, is the point of having a log.
    """
    if status not in STATUSES:
        raise ValueError(f"Unsupported status: {status}")
    # `closing` is its own parameter rather than a second use of $1: reusing the
    # status placeholder inside the CASE makes Postgres deduce both varchar and
    # text for it, which asyncpg refuses (AmbiguousParameterError).
    row = await pool.fetchrow(
        f"""UPDATE import_issues
            SET status = $1,
                resolution = $2::jsonb,
                resolved_at = CASE WHEN $3 THEN now() ELSE NULL END
            WHERE id = $4
            RETURNING {COLUMNS}""",
        status,
        json.dumps(resolution, default=str) if resolution is not None else None,
        status != OPEN,
        issue_id,
    )
    return _row(row) if row else None
