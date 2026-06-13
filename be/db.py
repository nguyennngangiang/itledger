"""asyncpg connection pool, created on app startup and closed on shutdown.

Routes get the pool via the `get_pool` FastAPI dependency.
"""
import asyncpg

from .config import settings

_pool: asyncpg.Pool | None = None


async def connect() -> None:
    """Open the global pool. Call once, on startup."""
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url, min_size=1, max_size=10
    )


async def disconnect() -> None:
    """Close the global pool. Call once, on shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    """FastAPI dependency: hand the live pool to a route."""
    if _pool is None:
        raise RuntimeError("DB pool is not initialized")
    return _pool
