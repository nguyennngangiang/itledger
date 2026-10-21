"""Shared ranker for the three `/semantic-search` endpoints and the Ask AI
fleet tools (be/routers/assistant.py's `semantic_search`, reused by
be/routers/documents.py).

Used to call a separate NPU-based embedding service (`ai/main.py`, retired
along with the D:\\LLM stack). Ranks the same way now with the local model
this host already runs for document RAG (be/embeddings.py, Ollama bge-m3) —
no separate service, no persistence: candidates are short flattened sentences
built fresh from the live fleet (be/documents.py), embedded in one batched
call, and ranked in-process. There is nothing here worth storing in pgvector
the way document chunks are — the fleet already changes underneath any cache
faster than a batched embed call costs.
"""
import math

from . import embeddings


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    return dot / (norm_a * norm_b) if norm_a and norm_b else 0.0


async def rank(query: str, documents: list[dict], top_k: int) -> list[dict]:
    """Rank `documents` ({id, text}) against `query`. Returns [{id, score}, ...],
    best match first. Raises HTTPException(503) if the embedder is unreachable
    (via be/embeddings.py), same contract the old NPU-service client had."""
    if not documents:
        return []
    query_vec = await embeddings.embed(query)
    doc_vecs = await embeddings.embed_many([d["text"] for d in documents])
    scored = [
        {"id": d["id"], "score": _cosine(query_vec, vec)}
        for d, vec in zip(documents, doc_vecs)
    ]
    scored.sort(key=lambda s: s["score"], reverse=True)
    return scored[: max(1, top_k)]
