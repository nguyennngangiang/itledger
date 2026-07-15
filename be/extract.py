"""Client for the LLM server's file-extraction endpoint (`POST /rag/extract`).

Forwards an uploaded file to the server, which parses it (xlsx via openpyxl, docx
via python-docx, native PDF via PyMuPDF) or OCRs it (scanned PDF / image via the
qwen2.5vl vision model) and returns the text plus any tables. The assistant feeds
that text into the grounded chat so Ask AI can reason over attachments.

We deliberately do NOT pass `ingest` — extraction only; nothing is written to the
shared RAG knowledge base.
"""
import httpx
from fastapi import HTTPException

from .config import settings


async def extract_file(name: str, mime: str, data: bytes) -> dict:
    """Extract text + tables from one file. Returns {text, tables, method, type}.
    Raises HTTPException if the extraction service is unreachable / errors."""
    headers = {}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"
    files = {"file": (name or "upload", data, mime or "application/octet-stream")}
    try:
        # OCR / vision fallback can be slow — give it room.
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(settings.rag_extract_url, files=files, headers=headers)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as e:  # noqa: BLE001
        raise HTTPException(502, f"File-extraction service error: {e}")
