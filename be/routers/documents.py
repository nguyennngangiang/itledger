"""Ask AI — one chat grounded in two things: an uploaded document library
(this module's own `documents` / `document_chunks`, see
be/repositories/document.py) AND the live fleet database (devices,
maintenance, handovers). Document retrieval always runs up front, as plain
context; fleet lookups are tool calls (`find_devices` / `device_history` /
`semantic_search`, reused from be/routers/assistant.py, which stays unmounted
as its own router — only its tool functions are imported here, so there is
exactly one Ask AI surface, not two). See the TOOLS comment below for why
these two are grounded differently.

Because answering may need a live tool call against Postgres, this always runs
server-side — there is no client-side (WebLLM) path any more. `/documents/ask`
streams as SSE regardless: a multi-round fleet tool loop on this host's
CPU-only Ollama can run for a while, and a caller needs to tell "still working
on it" (each tool call as it's dispatched) from "hung", the same reason
be/routers/imports.py streams a read.

Endpoints:
  POST /documents        upload -> extract -> chunk -> embed -> store
  GET  /documents         list the library
  DELETE /documents/{id}
  POST /documents/search  retrieval only, no LLM — a standalone "what would
                          match" lookup, not used by the chat UI (which does
                          its own retrieval — see `_ask_events`)
  POST /documents/ask     the chat: document context + fleet tools, streamed
                          as SSE
"""
import asyncio
import base64
import binascii
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import embeddings, extract, llm
from ..db import get_pool
from ..models.document import ChunkHit, DocumentOut, SearchRequest, SearchResult
from ..repositories import device as device_repo
from ..repositories import document as repo
from ..repositories import maintenance as maint_repo
from . import assistant

router = APIRouter(prefix="/documents", tags=["documents"])

# Same cap be/routers/imports.py uses for the same reason: a request body is
# not the place to discover a multi-hundred-MB upload.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# Character-based, not token-based: a tokenizer dependency buys precision this
# doesn't need. Overlap keeps a sentence that lands on a boundary readable in
# whichever chunk retrieval picks.
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200


class UploadRequest(BaseModel):
    name: str
    mime: str = ""
    data: str  # base64-encoded file bytes


def _chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Pack paragraphs into ~`size`-char chunks, splitting only on paragraph
    breaks so a sentence is never cut mid-way. Each new chunk repeats a tail of
    the previous one, so an answer landing near a boundary still has the text
    just before it."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return [text.strip()] if text.strip() else []
    chunks: list[str] = []
    current = ""
    for p in paragraphs:
        if current and len(current) + len(p) + 2 > size:
            chunks.append(current)
            current = current[-overlap:] + "\n\n" + p
        else:
            current = f"{current}\n\n{p}" if current else p
    if current.strip():
        chunks.append(current)
    return chunks


def _extracted_text(result: dict) -> str:
    """The extractor's {text, tables} -> one string to chunk and embed."""
    parts = [(result.get("text") or "").strip()]
    for t in result.get("tables") or []:
        md = (t.get("markdown") or "").strip()
        if md:
            parts.append(md)
    return "\n\n".join(p for p in parts if p)


@router.post("", response_model=DocumentOut, status_code=201)
async def upload_document(req: UploadRequest, pool=Depends(get_pool)):
    try:
        raw = base64.b64decode(req.data, validate=False)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "Dữ liệu base64 của file bị lỗi.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"File quá lớn ({len(raw) // 1024 // 1024} MB), tối đa 20 MB."
        )

    result = await extract.extract_file(req.name, req.mime, raw)
    text = _extracted_text(result)
    if not text:
        raise HTTPException(422, "Không trích xuất được nội dung nào từ file này.")

    chunks = _chunk_text(text)
    vectors = await embeddings.embed_many(chunks)

    # One transaction: a document row with no chunks (if the second insert
    # failed alone) would sit in the library looking normal but answer
    # nothing — searchable-or-absent, never half-stored.
    async with pool.acquire() as conn:
        async with conn.transaction():
            document = await repo.insert_document(
                conn, title=req.name, filename=req.name, mime=req.mime,
                char_count=len(text),
            )
            await repo.insert_chunks(conn, document["id"], list(zip(chunks, vectors)))
    return document


@router.get("", response_model=list[DocumentOut])
async def list_documents(pool=Depends(get_pool)):
    return await repo.list_documents(pool)


@router.delete("/{document_id}", status_code=204)
async def delete_document(document_id: int, pool=Depends(get_pool)):
    if not await repo.delete_document(pool, document_id):
        raise HTTPException(404, f"Document not found: {document_id}")


async def _retrieve(
    pool, question: str, top_k: int, document_id: int | None
) -> list[ChunkHit]:
    query_vec = await embeddings.embed(question)
    hits = await repo.search_chunks(pool, query_vec, top_k, document_id)
    return [ChunkHit(**h) for h in hits]


@router.post("/search", response_model=SearchResult)
async def search_documents(req: SearchRequest, pool=Depends(get_pool)):
    """Retrieval only, no LLM call — a standalone "what would match" lookup.
    The chat (`/ask`) does its own retrieval the same way (`_retrieve`,
    called directly, not through this endpoint) — see `_ask_events`."""
    chunks = await _retrieve(pool, req.question, req.top_k, req.document_id)
    return {"chunks": chunks}


# --- the fleet tools reused from assistant.py ------------------------------

# Fleet tools only (find_devices / device_history / semantic_search, reused
# from assistant.py). Document grounding is NOT a tool: an earlier version
# gave the model a `search_documents` tool and asked it to decide whether to
# call it, and on this host's small qwen2.5:3b (chosen for speed — see
# deploy/vps/docker-compose.vps.yml) that was unreliable in practice — roughly
# a third of the time it would announce "I should call search_documents" as
# TEXT instead of actually calling it, tool-calling reliability being the
# first thing a small model loses. Retrieval for the document library
# therefore always runs up front (same as the pre-agent /documents/ask did)
# and is handed to the model as plain context it can take or leave — nothing
# depends on it choosing to ask for it. Fleet lookups stay tool-based because
# they tested reliably (see be/tests/test_documents.py) and need per-question
# arguments (a serial, a status filter) that can't be precomputed generically
# the way "the top-K chunks for this question" can.
TOOLS = assistant.TOOLS


def _document_block(chunks: list[ChunkHit]) -> str:
    if not chunks:
        return ""
    excerpts = "\n\n".join(f"--- {c.title} ---\n{c.chunk_text}" for c in chunks)
    return (
        "\n\nDOCUMENT EXCERPTS possibly relevant to this question (from the "
        "uploaded document library) — use them if they answer the question, "
        "say nothing about them if they don't:\n" + excerpts + "\n"
    )


def _system_prompt(stats: str, doc_chunks: list[ChunkHit]) -> str:
    return (
        "You are the IT Ledger Ask AI assistant. You have two kinds of "
        "grounding: document excerpts below, if any (from an uploaded "
        "document library — policies, manuals, notes), and the live fleet "
        "database, with three linked resources: DEVICES (a machine, keyed by "
        "serial_number), MAINTENANCE (repair records linked to a device), and "
        "HANDOVERS (a device changing hands, from one person/team to "
        "another). They join on the device's serial number.\n\n"
        f"{stats}"
        f"{_document_block(doc_chunks)}\n"
        "For any count or total about the fleet, use the FLEET STATS numbers "
        "above verbatim — never tally rows yourself. For anything else about "
        "the fleet, CALL THE TOOLS: device_history for one machine's repairs "
        "and/or handovers (it joins all three tables), find_devices to filter "
        "the fleet, and semantic_search for fuzzy or Vietnamese natural-"
        "language fleet lookups. If the document excerpts above answer the "
        "question, use them directly — do not call a tool to re-fetch them. "
        "If neither the excerpts, the stats, nor the tools answer the "
        "question, say so plainly — never guess. Be concise; prefer bullet "
        "points when listing several things. Reply in the same language as "
        "the question (Vietnamese if the user writes Vietnamese)."
    )


def _history_messages(history) -> list[dict]:
    # Trimmed the same way assistant.py's Ask AI trimmed it (MAX_HISTORY=8) —
    # keeps the prompt from growing without bound over a long chat.
    return [
        {"role": "assistant" if m.role == "ai" else "user", "content": m.text}
        for m in (history or [])[-8:]
    ]


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def _ask_events(pool, req: SearchRequest) -> AsyncIterator[dict]:
    """The answer, reported as it goes. Document retrieval happens up front
    (see module docstring for why it isn't a tool call); fleet lookups are
    tool calls, made by `llm.chat_agent` — not a streaming call, and a
    multi-round tool loop can run for a while on this host's CPU-only Ollama,
    so `on_step` bridges each dispatch out through a queue while the agent
    runs as a background task, and the finished answer is chunked afterward
    so the UI's per-piece typing animation still applies."""
    doc_chunks = await _retrieve(pool, req.question, req.top_k, req.document_id)
    sources = [c.model_dump() for c in doc_chunks]

    devices = await device_repo.list_devices(pool)
    counts = await maint_repo.counts_by_device(pool)
    users = await assistant._users_map(pool)
    system = _system_prompt(assistant._fleet_stats(devices, counts, users), doc_chunks)

    messages = _history_messages(req.history)
    messages.append({"role": "user", "content": req.question})

    dispatch = assistant._dispatch(pool)

    queue: asyncio.Queue = asyncio.Queue()

    def on_step(name: str) -> None:
        queue.put_nowait({"phase": "tool_call", "tool": name})

    task = asyncio.create_task(
        llm.chat_agent(system, messages, TOOLS, dispatch, on_step=on_step)
    )
    yield {"phase": "thinking"}
    while not task.done():
        try:
            yield await asyncio.wait_for(queue.get(), timeout=0.5)
        except asyncio.TimeoutError:
            continue
    while not queue.empty():
        yield queue.get_nowait()

    result = await task  # re-raises HTTPException(503) if the LLM was unreachable

    if sources:
        yield {"phase": "sources", "sources": sources}

    answer = result.answer
    step = 40  # characters per piece — purely a typing-animation cadence
    for i in range(0, len(answer), step):
        yield {"phase": "answering", "piece": answer[i : i + step]}

    yield {
        "phase": "done",
        "result": {
            "answer": answer,
            "sources": sources,
            "tool_calls": result.tool_calls,
        },
    }


@router.post("/ask")
async def ask_documents(req: SearchRequest, pool=Depends(get_pool)):
    """The Ask AI chat: documents + live fleet data, one agentic call,
    streamed as SSE. Always server-side — see module docstring."""
    async def body() -> AsyncIterator[str]:
        try:
            async for event in _ask_events(pool, req):
                yield _sse(event)
        except HTTPException as e:
            yield _sse({"phase": "error", "status": e.status_code, "detail": e.detail})

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
