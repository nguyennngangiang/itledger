"""Test fixtures: a throwaway database and an ASGI client bound to it.

These tests TRUNCATE tables between cases, so the DSN is checked twice before
anything runs: the database name must end in `_test`, and it must differ from the
one the app is configured with. Pointing pytest at `itledger` is a hard error, not
a surprise.

The test database is created on the same Postgres the app uses (the compose `db`
service), so run pytest inside the api container where that hostname resolves:

    docker compose exec api sh -c \
      "pip install -r be/requirements-dev.txt && python -m pytest be -q"
"""
import asyncio
import os
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from be import db
from be.config import settings
from be.main import app
from be.repositories import feedback as feedback_repo
from be.repositories import import_issues as issues_repo

SCHEMA_FILE = Path(__file__).resolve().parent.parent / "sql" / "schema.sql"

# Every table the app owns, in FK-safe order for TRUNCATE ... CASCADE.
ALL_TABLES = (
    "handovers, maintenance, user_devices, devices, users, search_feedback, "
    "import_issues"
)


def _test_dsn() -> str:
    """DSN for the throwaway DB: the app's, with the database name swapped."""
    if override := os.getenv("TEST_DATABASE_URL"):
        dsn = override
    else:
        dsn = settings.database_url.rsplit("/", 1)[0] + "/itledger_test"

    name = dsn.rsplit("/", 1)[-1].split("?")[0]
    if not name.endswith("_test"):
        raise RuntimeError(
            f"Refusing to run: test database name {name!r} does not end in '_test'. "
            "These tests truncate tables."
        )
    if dsn == settings.database_url:
        raise RuntimeError("Refusing to run: test DSN equals the app's DATABASE_URL.")
    return dsn


async def _provision(dsn: str) -> None:
    name = dsn.rsplit("/", 1)[-1].split("?")[0]
    admin = await asyncpg.connect(dsn.rsplit("/", 1)[0] + "/postgres")
    try:
        if not await admin.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", name
        ):
            await admin.execute(f'CREATE DATABASE "{name}"')
    finally:
        await admin.close()

    # Rebuild from scratch each session so a schema.sql edit can never leave the
    # test DB drifted from the real one.
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        await conn.execute(SCHEMA_FILE.read_text(encoding="utf-8"))
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def database() -> str:
    """Provisioned once per run. Sync on purpose — keeps the async fixtures all
    function-scoped, which sidesteps pytest-asyncio event-loop scope pitfalls."""
    dsn = _test_dsn()
    asyncio.run(_provision(dsn))
    return dsn


@pytest_asyncio.fixture
async def pool(database: str):
    """A clean database per test, wired into the app two ways: the `get_pool`
    dependency (routers) and `db._pool` (things that call db.get_pool() directly,
    e.g. /healthz)."""
    p = await asyncpg.create_pool(dsn=database, min_size=1, max_size=4)
    await feedback_repo.ensure_table(p)
    await issues_repo.ensure_table(p)
    await p.execute(f"TRUNCATE {ALL_TABLES} RESTART IDENTITY CASCADE")

    db._pool = p
    app.dependency_overrides[db.get_pool] = lambda: p
    try:
        yield p
    finally:
        app.dependency_overrides.clear()
        db._pool = None
        await p.close()


@pytest_asyncio.fixture
async def client(pool):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


# --- sample data -----------------------------------------------------------
# Deliberately mirrors the real fleet's shape: a ghost IT store, Vietnamese names
# with diacritics (for the unaccent tests), and one device per owner.
GHOST = "IT-STORE"

USERS = [
    (GHOST, "IT Store", "IT"),
    ("VPHN216", "Nguyễn Minh Quân", "Accountant"),
    ("VPHN258", "Nguyễn Hương Giang", "Accounting"),
    ("VPHN228", "Trịnh Thế Hưng", "IT"),
]

DEVICES = [
    # serial, name, brand, os, owner, status
    ("SN-QUAN-1", "Asus Ryzen 5 16GB", "Asus", "Windows 11 Home SL", "VPHN216", "active"),
    ("SN-GIANG-1", "HP Core i3 8GB", "HP", "Windows 11 Pro", "VPHN258", "active"),
    ("SN-STORE-1", "Dell Latitude", "Dell", "Windows 10 Pro", GHOST, "in_stock"),
]


@pytest_asyncio.fixture
async def seed(pool):
    await pool.executemany(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)", USERS
    )
    await pool.executemany(
        "INSERT INTO devices (serial_number, name, brand, os, user_id, status) "
        "VALUES ($1,$2,$3,$4,$5,$6)",
        DEVICES,
    )
    return {"users": USERS, "devices": DEVICES}
