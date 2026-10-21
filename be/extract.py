"""Local file-text extraction — no external service.

Used to forward every file to an HTTP endpoint on the retired D:\\LLM stack,
which parsed xlsx/docx/native-PDF and OCR'd scanned PDFs/images via a vision
model. That host is gone. Native xlsx/docx/PDF text needed no model to begin
with — it's cheap CPU parsing — so it is done right here with plain libraries.

OCR of scanned PDFs/images is NOT reimplemented: a vision model is far too
heavy for this host's CPU-only ARM cores. Those formats raise a clear 415
instead of hanging on a dead endpoint, same as an unrecognised format always did.

Callers (be/routers/documents.py, be/routers/imports.py) are unchanged: this
keeps the same `{text, tables, method, type}` shape and the same
`HTTPException` contract the old HTTP client raised.
"""
from io import BytesIO

import fitz  # PyMuPDF
from docx import Document
from fastapi import HTTPException
from openpyxl import load_workbook

UNSUPPORTED = (
    "Chỉ đọc được văn bản (.xlsx, .docx, .pdf dạng văn bản, .txt/.csv/...). "
    "Đọc ảnh hoặc PDF dạng scan cần OCR, hiện chưa hỗ trợ trên máy chủ này."
)

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PDF_MIME = "application/pdf"

# Already text — decode directly rather than routing through a parser library.
_TEXT_EXTS = {"txt", "md", "csv", "tsv", "json", "log", "yaml", "yml"}


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _is_text(name: str, mime: str) -> bool:
    return mime.startswith("text/") or _ext(name) in _TEXT_EXTS


def _table_markdown(header: list[str], body: list[list[str]]) -> str:
    md = "| " + " | ".join(header) + " |\n"
    md += "| " + " | ".join("---" for _ in header) + " |\n"
    for row in body:
        md += "| " + " | ".join(row) + " |\n"
    return md


def _extract_xlsx(data: bytes) -> dict:
    try:
        wb = load_workbook(BytesIO(data), data_only=True)
        tables = []
        for ws in wb.worksheets:
            rows = [
                [("" if cell is None else str(cell)) for cell in row]
                for row in ws.iter_rows(values_only=True)
            ]
            rows = [r for r in rows if any(cell for cell in r)]
            if not rows:
                continue
            header, *body = rows
            tables.append({"sheet": ws.title, "markdown": _table_markdown(header, body)})
    except Exception as e:  # noqa: BLE001 — a corrupt upload, not a server bug
        raise HTTPException(422, f"Không đọc được file Excel này: {e}") from e
    return {"text": "", "tables": tables, "method": "openpyxl", "type": "xlsx"}


def _extract_docx(data: bytes) -> dict:
    try:
        doc = Document(BytesIO(data))
        text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
        tables = []
        for t in doc.tables:
            rows = [[cell.text.strip() for cell in row.cells] for row in t.rows]
            if not rows:
                continue
            header, *body = rows
            tables.append({"markdown": _table_markdown(header, body)})
    except Exception as e:  # noqa: BLE001 — a corrupt upload, not a server bug
        raise HTTPException(422, f"Không đọc được file Word này: {e}") from e
    return {"text": text, "tables": tables, "method": "python-docx", "type": "docx"}


def _extract_pdf(data: bytes) -> dict:
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        pages = [page.get_text() for page in doc]
    except Exception as e:  # noqa: BLE001 — a corrupt upload, not a server bug
        raise HTTPException(422, f"Không đọc được file PDF này: {e}") from e
    text = "\n\n".join(p.strip() for p in pages if p.strip())
    if not text:
        # Opened fine but carries no text layer — almost certainly a scanned
        # PDF, which needs OCR this host does not run.
        raise HTTPException(415, UNSUPPORTED)
    return {"text": text, "tables": [], "method": "pymupdf", "type": "pdf"}


async def extract_file(name: str, mime: str, data: bytes) -> dict:
    """Extract text + tables from one file. Returns {text, tables, method, type}.
    Raises HTTPException(415) for a format not readable locally (images,
    scanned PDFs, anything else)."""
    if _is_text(name, mime):
        return {
            "text": data.decode("utf-8", errors="replace").strip(),
            "tables": [], "method": "text", "type": "text",
        }
    ext = _ext(name)
    if mime == _XLSX_MIME or ext == "xlsx":
        return _extract_xlsx(data)
    if mime == _DOCX_MIME or ext == "docx":
        return _extract_docx(data)
    if mime == _PDF_MIME or ext == "pdf":
        return _extract_pdf(data)
    raise HTTPException(415, UNSUPPORTED)
