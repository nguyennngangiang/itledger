"""Thin client for the local embedding model — Ollama's own `/api/embeddings`.

Separate from be/llm.py because embeddings use Ollama's native API, not the
OpenAI-compatible one chat uses (no `/v1`), and because embeddings have no
`ai_enabled` gate: retrieval has no remote dependency once Ollama is up, so it
stays available even if the chat fallback (`llm.py`, used only by
`/documents/ask`) is unreachable.

This is the ONLY thing that must stay consistent between ingest and query:
change `settings.embed_model` and every already-stored vector goes stale — the
only fix is re-ingesting every document.
"""
import httpx
from fastapi import HTTPException

from .config import settings


async def embed(text: str) -> list[float]:
    """One text -> one embedding vector."""
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{settings.embed_base_url}/api/embeddings",
                json={"model": settings.embed_model, "prompt": text},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(503, f"Embedding service unavailable: {e}")
    embedding = data.get("embedding")
    if not embedding:
        raise HTTPException(503, "Embedding service returned no vector")
    return embedding


async def embed_many(texts: list[str]) -> list[list[float]]:
    """Many texts -> many vectors, in ONE request via Ollama's batch `/api/embed`.

    Matters beyond a document's own chunks: be/search.py embeds the WHOLE
    fleet (up to ~350 devices) per semantic-search call, and that many
    sequential round-trips would make every such search and every Ask AI
    fleet-lookup tool call pay for it.
    """
    if not texts:
        return []
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{settings.embed_base_url}/api/embed",
                json={"model": settings.embed_model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(503, f"Embedding service unavailable: {e}")
    vectors = data.get("embeddings")
    if not vectors or len(vectors) != len(texts):
        raise HTTPException(503, "Embedding service returned an unexpected shape")
    return vectors
