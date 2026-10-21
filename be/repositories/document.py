"""Document RAG data access. SQL lives here; the router stays thin.

Documents are files uploaded ONCE and kept for repeated Q&A — unlike the
retired Ask AI feature, which only ever read an attachment for the one question
it rode in on. Each document is split into chunks at upload time and each
chunk's embedding is stored alongside it, so answering a question re-embeds
only the question, then ranks it against what is already stored with
pgvector's `<=>` (cosine distance) operator — never a per-question re-read of
the whole corpus.

asyncpg has no `vector` codec, so embeddings cross the wire as text and are
cast with `::vector` on the way in (`_vec`) and never selected back out raw —
every query here reads `score` (a computed double), never the column itself.
"""
import asyncpg

COLUMNS = "id, title, filename, mime, uploaded_at, char_count, status"

DOCUMENTS_DDL = """
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    mime VARCHAR(100),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    char_count INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS document_chunks (
    id BIGSERIAL PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    chunk_text TEXT NOT NULL,
    -- bge-m3 (be/config.py EMBED_MODEL) is 1024-dimensional. Changing the
    -- embedding model means re-ingesting every document — the dimension (and
    -- the vector space itself) is baked into every stored row.
    embedding vector(1024) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding
    ON document_chunks USING hnsw (embedding vector_cosine_ops);
"""


# DOCUMENTS_DDL is applied at startup by be/migrations.py.


def _vec(embedding: list[float]) -> str:
    """Python floats -> pgvector's text input format: `[0.1,0.2,...]`."""
    return "[" + ",".join(str(x) for x in embedding) + "]"


async def insert_document(
    conn: asyncpg.Connection | asyncpg.Pool,
    *, title: str, filename: str, mime: str, char_count: int,
) -> dict:
    row = await conn.fetchrow(
        f"""INSERT INTO documents (title, filename, mime, char_count)
            VALUES ($1, $2, $3, $4)
            RETURNING {COLUMNS}""",
        title, filename, mime, char_count,
    )
    return dict(row)


async def insert_chunks(
    conn: asyncpg.Connection | asyncpg.Pool,
    document_id: int,
    chunks: list[tuple[str, list[float]]],
) -> None:
    """Batch-insert (chunk_text, embedding) pairs, already in reading order."""
    if not chunks:
        return
    await conn.executemany(
        """INSERT INTO document_chunks (document_id, chunk_index, chunk_text, embedding)
            VALUES ($1, $2, $3, $4::vector)""",
        [
            (document_id, i, text, _vec(embedding))
            for i, (text, embedding) in enumerate(chunks)
        ],
    )


async def list_documents(pool: asyncpg.Pool) -> list[dict]:
    rows = await pool.fetch(f"SELECT {COLUMNS} FROM documents ORDER BY uploaded_at DESC")
    return [dict(r) for r in rows]


async def delete_document(pool: asyncpg.Pool, document_id: int) -> bool:
    """Chunks cascade with the parent row (ON DELETE CASCADE)."""
    result = await pool.execute("DELETE FROM documents WHERE id = $1", document_id)
    return result != "DELETE 0"


async def search_chunks(
    pool: asyncpg.Pool,
    embedding: list[float],
    top_k: int,
    document_id: int | None = None,
) -> list[dict]:
    """Nearest chunks by cosine distance, optionally scoped to one document.

    `score` is similarity (1 - cosine distance) rather than raw distance, so a
    caller/UI reads 1.0 as an exact match and 0 as unrelated instead of having
    to know pgvector's distance convention.
    """
    vec = _vec(embedding)
    if document_id is not None:
        rows = await pool.fetch(
            """SELECT c.document_id, c.chunk_text,
                      1 - (c.embedding <=> $1::vector) AS score,
                      d.title
                FROM document_chunks c
                JOIN documents d ON d.id = c.document_id
                WHERE c.document_id = $2
                ORDER BY c.embedding <=> $1::vector
                LIMIT $3""",
            vec, document_id, top_k,
        )
    else:
        rows = await pool.fetch(
            """SELECT c.document_id, c.chunk_text,
                      1 - (c.embedding <=> $1::vector) AS score,
                      d.title
                FROM document_chunks c
                JOIN documents d ON d.id = c.document_id
                ORDER BY c.embedding <=> $1::vector
                LIMIT $2""",
            vec, top_k,
        )
    return [dict(r) for r in rows]
