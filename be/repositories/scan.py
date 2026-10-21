"""Scan-screen data access: the corrections Claude learns from, and the
serial lookup the review screen needs before saving.

`scan_examples` holds one row per saved reading that a person had to correct —
`notes` is the plain-language list of what changed (see scan.correction_notes).
The newest rows are fed back into the next read as worked examples; nothing is
trained. Readings saved without a change are not stored: they teach nothing and
would push the useful ones out of the window.
"""
import json

import asyncpg

SCAN_DDL = """
CREATE TABLE IF NOT EXISTS scan_examples (
    id BIGSERIAL PRIMARY KEY,
    vendor VARCHAR(200) NOT NULL DEFAULT '',
    doc_type VARCHAR(200) NOT NULL DEFAULT '',
    notes JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_examples_created ON scan_examples (created_at DESC);
"""

# How many corrections go in front of a read. Each is a few lines; this keeps
# the prompt small while covering the handful of suppliers the company uses.
EXAMPLES_IN_PROMPT = 12


async def add_example(pool: asyncpg.Pool, vendor: str, doc_type: str, notes_json: str) -> None:
    await pool.execute(
        "INSERT INTO scan_examples (vendor, doc_type, notes) VALUES ($1, $2, $3::jsonb)",
        vendor[:200], doc_type[:200], notes_json,
    )


async def recent_examples(pool: asyncpg.Pool, limit: int = EXAMPLES_IN_PROMPT) -> list[dict]:
    rows = await pool.fetch(
        "SELECT vendor, doc_type, notes FROM scan_examples ORDER BY created_at DESC LIMIT $1",
        limit,
    )
    return [
        {"vendor": r["vendor"], "doc_type": r["doc_type"], "notes": json.loads(r["notes"])}
        for r in rows
    ]


async def count_examples(pool: asyncpg.Pool) -> int:
    return await pool.fetchval("SELECT count(*) FROM scan_examples")


async def existing_serials(pool: asyncpg.Pool, serials: list[str]) -> list[str]:
    """Which of these serials the ledger already has, deleted rows included —
    an insert would collide with a trashed device too."""
    if not serials:
        return []
    rows = await pool.fetch(
        "SELECT serial_number FROM devices WHERE serial_number = ANY($1::varchar[])",
        serials,
    )
    return [r["serial_number"] for r in rows]
