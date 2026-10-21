"""Document RAG: upload -> chunk -> embed -> store, then retrieval and ask.

The embedder and the chat model are both monkeypatched — these tests are about
what the router and repository do with their answers, not about Ollama itself.
`_fake_embed` is a real (if tiny) bag-of-words vector so ranking assertions
mean something: a query sharing words with one chunk should score it above an
unrelated one, the same property the real bge-m3 embeddings have.
"""
import hashlib

import pytest
from fastapi import HTTPException

from be import embeddings, extract, llm


def _fake_embed_one(text: str) -> list[float]:
    vec = [0.0] * 1024
    for word in text.lower().split():
        idx = int(hashlib.md5(word.encode()).hexdigest(), 16) % 1024
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


def _fake_extract(text: str):
    async def extract_file(name, mime, data):
        return {"text": text, "tables": [], "method": "fake", "type": "txt"}
    return extract_file


async def test_upload_chunks_and_embeds_the_extracted_text(client, pool, monkeypatch):
    monkeypatch.setattr(
        extract, "extract_file",
        _fake_extract("Máy in HP bị kẹt giấy thường xuyên vào buổi sáng."),
    )
    r = await client.post(
        "/documents", json={"name": "note.txt", "mime": "text/plain", "data": "eA=="}
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["title"] == "note.txt"
    assert body["char_count"] > 0

    chunks = await pool.fetch(
        "SELECT chunk_index, chunk_text FROM document_chunks "
        "WHERE document_id = $1 ORDER BY chunk_index",
        body["id"],
    )
    assert len(chunks) == 1
    assert "kẹt giấy" in chunks[0]["chunk_text"]


async def test_upload_rejects_a_file_with_no_extractable_text(client, monkeypatch):
    monkeypatch.setattr(extract, "extract_file", _fake_extract(""))
    r = await client.post(
        "/documents", json={"name": "empty.txt", "mime": "text/plain", "data": "eA=="}
    )
    assert r.status_code == 422


async def test_list_and_delete_document(client, monkeypatch):
    monkeypatch.setattr(extract, "extract_file", _fake_extract("Nội dung bất kỳ."))
    created = (await client.post(
        "/documents", json={"name": "a.txt", "mime": "text/plain", "data": "eA=="}
    )).json()

    listed = (await client.get("/documents")).json()
    assert [d["id"] for d in listed] == [created["id"]]

    r = await client.delete(f"/documents/{created['id']}")
    assert r.status_code == 204
    assert (await client.get("/documents")).json() == []


async def test_delete_missing_document_404s(client):
    r = await client.delete("/documents/999999")
    assert r.status_code == 404


async def test_search_ranks_the_matching_document_first(client, monkeypatch):
    monkeypatch.setattr(
        extract, "extract_file",
        _fake_extract("Máy in HP bị kẹt giấy, cần thay trục cuốn giấy."),
    )
    await client.post(
        "/documents", json={"name": "printer.txt", "mime": "text/plain", "data": "eA=="}
    )
    monkeypatch.setattr(
        extract, "extract_file",
        _fake_extract("Modem wifi TP-Link mất kết nối, cần khởi động lại router."),
    )
    await client.post(
        "/documents", json={"name": "wifi.txt", "mime": "text/plain", "data": "eA=="}
    )

    r = await client.post(
        "/documents/search", json={"question": "máy in bị kẹt giấy", "top_k": 2}
    )
    assert r.status_code == 200, r.text
    hits = r.json()["chunks"]
    assert hits[0]["title"] == "printer.txt"
    assert hits[0]["score"] > hits[1]["score"]


async def test_search_scoped_to_one_document_ignores_the_rest(client, monkeypatch):
    monkeypatch.setattr(extract, "extract_file", _fake_extract("Máy in HP kẹt giấy."))
    a = (await client.post(
        "/documents", json={"name": "a.txt", "mime": "text/plain", "data": "eA=="}
    )).json()
    monkeypatch.setattr(extract, "extract_file", _fake_extract("Modem wifi mất kết nối."))
    await client.post(
        "/documents", json={"name": "b.txt", "mime": "text/plain", "data": "eA=="}
    )

    r = await client.post(
        "/documents/search",
        json={"question": "kết nối wifi", "document_id": a["id"], "top_k": 5},
    )
    hits = r.json()["chunks"]
    assert all(h["document_id"] == a["id"] for h in hits)


async def test_search_on_an_empty_library_returns_no_chunks(client):
    r = await client.post("/documents/search", json={"question": "bất kỳ câu hỏi nào"})
    assert r.status_code == 200
    assert r.json()["chunks"] == []


def _sse_events(text: str) -> list[dict]:
    import json
    events = []
    for block in text.split("\n\n"):
        lines = [l[5:].strip() for l in block.splitlines() if l.startswith("data:")]
        if lines:
            events.append(json.loads("".join(lines)))
    return events


async def test_ask_grounds_the_prompt_with_relevant_document_excerpts(client, monkeypatch):
    """Document retrieval is NOT a tool call (see be/routers/documents.py's
    comment on TOOLS for why — a small model unreliably chose to call it) —
    it always runs up front and is handed to the model as context. This
    checks the excerpt actually reaches the system prompt and the chunk comes
    back as a source, independent of what the (faked) model does with it."""
    monkeypatch.setattr(
        extract, "extract_file", _fake_extract("Máy in HP bị kẹt giấy, thay trục cuốn.")
    )
    await client.post(
        "/documents", json={"name": "printer.txt", "mime": "text/plain", "data": "eA=="}
    )

    captured = {}

    async def fake_chat_agent(system, messages, tools, dispatch, **kwargs):
        captured["system"] = system
        return llm.AgentResult("Thay trục cuốn giấy.", [], 1)

    monkeypatch.setattr(llm, "chat_agent", fake_chat_agent)

    async with client.stream(
        "POST", "/documents/ask", json={"question": "máy in bị kẹt giấy phải làm sao"}
    ) as r:
        assert r.status_code == 200
        body = await r.aread()

    assert "kẹt giấy" in captured["system"]
    events = _sse_events(body.decode())
    assert events[-1]["phase"] == "done"
    assert events[-1]["result"]["answer"] == "Thay trục cuốn giấy."
    assert events[-1]["result"]["sources"][0]["title"] == "printer.txt"
    assert events[-1]["result"]["tool_calls"] == []


async def test_ask_can_use_fleet_tools_with_no_documents_uploaded(client, pool, seed, monkeypatch):
    """A question with nothing to do with the document library still answers,
    via assistant.py's fleet tools (find_devices here), reused as-is — the
    whole point of merging the two."""
    async def fake_chat_agent(system, messages, tools, dispatch, **kwargs):
        on_step = kwargs.get("on_step")
        if on_step:
            on_step("find_devices")
        result = await dispatch("find_devices", {"status": "in_stock"})
        assert "SN-STORE-1" in result
        return llm.AgentResult("Có 1 máy đang trong kho.", ["find_devices"], 1)

    monkeypatch.setattr(llm, "chat_agent", fake_chat_agent)

    async with client.stream(
        "POST", "/documents/ask", json={"question": "còn máy nào trong kho không"}
    ) as r:
        body = await r.aread()

    events = _sse_events(body.decode())
    assert "tool_call" in [e["phase"] for e in events]
    assert events[-1]["result"]["answer"] == "Có 1 máy đang trong kho."
    assert events[-1]["result"]["tool_calls"] == ["find_devices"]
    assert events[-1]["result"]["sources"] == []


async def test_ask_reports_a_clean_error_when_the_llm_is_unreachable(client, monkeypatch):
    async def fake_chat_agent(*a, **k):
        raise HTTPException(503, "LLM unavailable: boom")

    monkeypatch.setattr(llm, "chat_agent", fake_chat_agent)

    async with client.stream(
        "POST", "/documents/ask", json={"question": "bất kỳ câu hỏi nào"}
    ) as r:
        assert r.status_code == 200  # SSE already opened; the failure is an event
        body = await r.aread()

    events = _sse_events(body.decode())
    assert events[-1]["phase"] == "error"
    assert events[-1]["status"] == 503
