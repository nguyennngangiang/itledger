"""Search-feedback data access. SQL lives here; the router stays thin.

Each row is a user marking a smart-search result correct (label=1) for a query
on a given resource. `examples_for_query` pulls positive marks to seed the LLM
reranker as few-shot anchors (be/llm.rerank). This is per-project steering — the
shared model is never trained. No FK to the resource tables so marks survive a
purge.
"""
import asyncpg

from ..models.feedback import FeedbackCreate

COLUMNS = "id, resource, item_id, query, document, score, label, created_at"

FEEDBACK_DDL = """
CREATE TABLE IF NOT EXISTS search_feedback (
    id BIGSERIAL PRIMARY KEY,
    resource VARCHAR(32) NOT NULL DEFAULT 'devices',
    item_id VARCHAR(100),
    query TEXT NOT NULL,
    document TEXT,
    score DOUBLE PRECISION,
    label SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);
-- Migrate tables created before the resource-aware refactor (older DBs may have
-- a `device_id` column and lack `resource` / `item_id`).
ALTER TABLE search_feedback ADD COLUMN IF NOT EXISTS resource VARCHAR(32) NOT NULL DEFAULT 'devices';
ALTER TABLE search_feedback ADD COLUMN IF NOT EXISTS item_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_search_feedback_query
    ON search_feedback (resource, lower(query));
"""


async def ensure_table(pool: asyncpg.Pool) -> None:
    """Create the table on already-running databases (schema.sql only runs on a
    fresh volume)."""
    await pool.execute(FEEDBACK_DDL)


async def create(pool: asyncpg.Pool, fb: FeedbackCreate) -> dict:
    row = await pool.fetchrow(
        f"""INSERT INTO search_feedback (resource, item_id, query, document, score, label)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING {COLUMNS}""",
        fb.resource,
        fb.item_id,
        fb.query,
        fb.document,
        fb.score,
        fb.label,
    )
    return dict(row)


async def list_feedback(pool: asyncpg.Pool, limit: int = 500) -> list[dict]:
    rows = await pool.fetch(
        f"SELECT {COLUMNS} FROM search_feedback ORDER BY created_at DESC LIMIT $1",
        limit,
    )
    return [dict(r) for r in rows]


async def count(pool: asyncpg.Pool) -> int:
    return await pool.fetchval("SELECT count(*) FROM search_feedback")


async def examples_for_query(
    pool: asyncpg.Pool, resource: str, query: str, limit: int = 6
) -> list[dict]:
    """Positive marks for this resource, to seed the reranker as few-shot anchors.
    Exact-query matches first, then most recent."""
    rows = await pool.fetch(
        f"""SELECT {COLUMNS} FROM search_feedback
            WHERE resource = $1 AND label = 1 AND document IS NOT NULL
            ORDER BY (lower(query) = lower($2)) DESC, created_at DESC
            LIMIT $3""",
        resource,
        query,
        limit,
    )
    return [dict(r) for r in rows]
