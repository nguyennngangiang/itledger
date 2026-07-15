"""Shared client for the local embedding ranker (the `ai` service `POST /rank`).

One place for the httpx call every semantic-search endpoint — and the assistant's
`semantic_search` tool — shares. Raises HTTPException(503) if the embedder is
unreachable so callers surface a clean error instead of a 500.
"""
import httpx
from fastapi import HTTPException

from .config import settings


async def rank(query: str, documents: list[dict], top_k: int) -> list[dict]:
    """Rank `documents` ({id, text}) against `query`. Returns [{id, score}, ...]."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.ai_url}/rank",
                json={"query": query, "documents": documents, "top_k": top_k},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(503, f"AI search service unavailable: {e}")
