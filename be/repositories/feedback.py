"""Search-feedback data access. SQL lives here; the router stays thin.

These rows are the training / steering signal for the LLM reranker: each is a
user saying "for query Q, device D is (not) a right result". `examples_for_query`
pulls positive marks to use as few-shot anchors at rerank time; the LoRA export
turns the whole table into a fine-tuning dataset.
"""
import asyncpg

from ..models.feedback import FeedbackCreate

COLUMNS = "id, query, device_id, document, score, label, created_at"

# Created at startup (see main.py lifespan) so existing databases pick it up
# without a `docker compose down -v`. No FK to devices on purpose — a label
# should survive the device being purged.
FEEDBACK_DDL = """
CREATE TABLE IF NOT EXISTS search_feedback (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    device_id VARCHAR(100),
    document TEXT,
    score DOUBLE PRECISION,
    label SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_feedback_query
    ON search_feedback (lower(query));
"""


async def ensure_table(pool: asyncpg.Pool) -> None:
    await pool.execute(FEEDBACK_DDL)


async def create(pool: asyncpg.Pool, fb: FeedbackCreate) -> dict:
    row = await pool.fetchrow(
        f"""INSERT INTO search_feedback (query, device_id, document, score, label)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING {COLUMNS}""",
        fb.query,
        fb.device_id,
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
    pool: asyncpg.Pool, query: str, limit: int = 6
) -> list[dict]:
    """Positive marks to seed the reranker as few-shot examples. Exact-query
    matches rank first (most on-point), then the most recent positives so the
    LLM always sees the expected output format."""
    rows = await pool.fetch(
        f"""SELECT {COLUMNS} FROM search_feedback
            WHERE label = 1 AND document IS NOT NULL
            ORDER BY (lower(query) = lower($1)) DESC, created_at DESC
            LIMIT $2""",
        query,
        limit,
    )
    return [dict(r) for r in rows]
