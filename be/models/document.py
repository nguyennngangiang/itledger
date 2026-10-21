"""Document RAG schemas."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class DocumentOut(BaseModel):
    id: int
    title: str
    filename: str
    mime: str | None = None
    uploaded_at: datetime
    char_count: int
    status: str


class ChunkHit(BaseModel):
    document_id: int
    title: str
    chunk_text: str
    score: float


class ChatMsg(BaseModel):
    """One prior turn, sent back so a follow-up ("what about its handovers?")
    can resolve. Same shape components/AskAiScreen.tsx already keeps client-side."""
    role: Literal["user", "ai"]
    text: str


class SearchRequest(BaseModel):
    question: str
    document_id: int | None = None
    top_k: int = 6
    history: list[ChatMsg] | None = None


class SearchResult(BaseModel):
    chunks: list[ChunkHit]


class AskDocsResult(BaseModel):
    answer: str
    sources: list[ChunkHit]
    # Which tools the agent called, in order (e.g. ["search_documents",
    # "find_devices"]) — powers the trace chips in the UI.
    tool_calls: list[str] = []
