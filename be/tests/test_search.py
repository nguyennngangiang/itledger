"""be/search.py's rank() — cosine ranking over embeddings, no external service
(replaces the old NPU-based ranker). The embedder is faked with a tiny
bag-of-words vector, same technique test_documents.py uses, so a query
sharing words with one candidate scores it above an unrelated one."""
import hashlib

import pytest

from be import embeddings, search


def _fake_embed_one(text: str) -> list[float]:
    vec = [0.0] * 64
    for word in text.lower().split():
        idx = int(hashlib.md5(word.encode()).hexdigest(), 16) % 64
        vec[idx] += 1.0
    norm = sum(v * v for v in vec) ** 0.5
    return [v / norm for v in vec] if norm else vec


@pytest.fixture(autouse=True)
def _fake_embedder(monkeypatch):
    async def embed(text: str) -> list[float]:
        return _fake_embed_one(text)

    async def embed_many(texts: list[str]) -> list[list[float]]:
        return [_fake_embed_one(t) for t in texts]

    monkeypatch.setattr(embeddings, "embed", embed)
    monkeypatch.setattr(embeddings, "embed_many", embed_many)


async def test_rank_orders_by_similarity_best_first():
    documents = [
        {"id": "a", "text": "may in bi ket giay"},
        {"id": "b", "text": "modem wifi mat ket noi"},
    ]
    ranked = await search.rank("may in ket giay", documents, top_k=2)
    assert [r["id"] for r in ranked][0] == "a"
    assert ranked[0]["score"] > ranked[1]["score"]


async def test_rank_respects_top_k():
    documents = [{"id": str(i), "text": f"item number {i}"} for i in range(5)]
    ranked = await search.rank("item number 2", documents, top_k=2)
    assert len(ranked) == 2


async def test_rank_on_no_documents_returns_empty_without_calling_the_embedder(monkeypatch):
    async def _boom(*a, **k):
        raise AssertionError("should not embed anything when there are no candidates")

    monkeypatch.setattr(embeddings, "embed", _boom)
    assert await search.rank("query", [], top_k=5) == []
