"""Every schema change the live database needs, in order, as idempotent DDL.

`sql/schema.sql` builds a FRESH volume (Postgres runs it from
docker-entrypoint-initdb.d) and is never re-run. This module is what an
*already-running* database gets, on every boot. Both have to describe the same
shape, and drifting them apart is the failure mode to watch for.

It replaces four separate lifespan calls plus DDL scattered across
repositories/feedback.py, repositories/import_issues.py and repositories/user.py.
Collecting them buys one thing that matters beyond tidiness: the test database is
now provisioned exactly the way production is — fresh schema.sql, then
migrations — which it was not before, so tests validated a shape production
might not have.

Deliberately no `schema_migrations` ledger table. Every statement here is already
idempotent (IF EXISTS / IF NOT EXISTS / ON CONFLICT), so a ledger would be a
performance optimisation, not a correctness mechanism — and it would add its own
failure mode: recorded-but-half-applied. At one developer, one host and roughly
one schema change a month, that trade is not worth making. Alembic even less so:
it drags SQLAlchemy into a project that uses raw asyncpg by design, and its
autogenerate cannot see hand-written SQL.

Rules for adding one:

  1. Every statement is idempotent. IF EXISTS / IF NOT EXISTS, always.
  2. Append only. Never edit an entry that has already shipped.
  3. Nothing here may take a long lock or rewrite a table — it runs at startup
     against a live LAN deployment. Anything that would goes in sql/migrations/
     and is applied by hand (see 0001_retire_user_devices.sql).

No advisory lock: uvicorn runs a single worker here (docker-compose.prod.yml).
Add pg_advisory_xact_lock the day that changes.
"""
import asyncpg

from .repositories.feedback import FEEDBACK_DDL
from .repositories.import_issues import IMPORT_ISSUES_DDL
from .repositories.user import GHOST_DDL, USER_MIGRATIONS_DDL

MIGRATIONS: list[tuple[str, str]] = [
    ("0001_search_feedback", FEEDBACK_DDL),
    ("0002_import_issues", IMPORT_ISSUES_DDL),
    ("0003_user_columns", USER_MIGRATIONS_DDL),
    ("0004_ghost_user", GHOST_DDL),
]


async def run(pool: asyncpg.Pool) -> None:
    """Apply every migration, in order. Safe to call on every startup."""
    for _version, ddl in MIGRATIONS:
        await pool.execute(ddl)
