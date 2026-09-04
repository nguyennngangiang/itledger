"""Client for the LLM server's file-extraction endpoint (`POST /rag/extract`).

Forwards an uploaded file to the server, which parses it (xlsx via openpyxl, docx
via python-docx, native PDF via PyMuPDF) or OCRs it (scanned PDF / image via the
qwen2.5vl vision model) and returns the text plus any tables.

DORMANT: that server is the retired D:\\LLM stack, so `settings.ai_enabled` is off
and every call is refused up front. Import still reads the company's Excel handover
template — `be/handover_sheet.py` does that in plain code — but PDFs and photos have
no reader without this. Kept intact for whenever the stack comes back.

We deliberately do NOT pass `ingest` — extraction only; nothing is written to the
shared RAG knowledge base.
"""
import httpx
from fastapi import HTTPException

from .config import settings

# Shown to the user, so it says what to do instead rather than naming a service they
# have never heard of.
DISABLED = (
    "Chỉ đọc được file Excel (.xlsx) đúng mẫu biên bản bàn giao. "
    "Đọc PDF/ảnh cần dịch vụ AI, hiện đã ngừng hoạt động."
)


async def extract_file(name: str, mime: str, data: bytes) -> dict:
    """Extract text + tables from one file. Returns {text, tables, method, type}.
    Raises HTTPException if extraction is switched off, or the service is
    unreachable / errors."""
    if not settings.ai_enabled:
        # 503 rather than 502: the service is not broken, it is gone on purpose.
        raise HTTPException(503, DISABLED)
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
