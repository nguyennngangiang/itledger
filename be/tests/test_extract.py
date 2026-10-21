"""be/extract.py against real files — no mocking. test_documents.py mocks this
module entirely (it's testing the router, not the parser), which is exactly how
a missing format (plain text was forgotten on the first pass) went unnoticed;
these exercise the real openpyxl/python-docx/pymupdf/text paths directly."""
from io import BytesIO

import pytest
from docx import Document
from fastapi import HTTPException
from openpyxl import Workbook

from be import extract


async def test_plain_text_is_decoded_directly():
    result = await extract.extract_file(
        "note.txt", "text/plain", "Máy in bị kẹt giấy.".encode("utf-8")
    )
    assert result["text"] == "Máy in bị kẹt giấy."
    assert result["method"] == "text"


async def test_csv_by_extension_is_treated_as_text():
    result = await extract.extract_file("data.csv", "", b"a,b\n1,2\n")
    assert result["text"] == "a,b\n1,2"


async def test_xlsx_becomes_a_markdown_table():
    wb = Workbook()
    ws = wb.active
    ws.append(["Serial", "Model"])
    ws.append(["5CD03347TB", "HP EliteBook"])
    buf = BytesIO()
    wb.save(buf)

    result = await extract.extract_file(
        "devices.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buf.getvalue(),
    )
    assert "5CD03347TB" in result["tables"][0]["markdown"]


async def test_docx_paragraphs_and_tables_both_come_back():
    doc = Document()
    doc.add_paragraph("Hướng dẫn bảo trì máy in.")
    table = doc.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "Lỗi"
    table.rows[0].cells[1].text = "Cách xử lý"
    table.rows[1].cells[0].text = "Kẹt giấy"
    table.rows[1].cells[1].text = "Thay trục cuốn"
    buf = BytesIO()
    doc.save(buf)

    result = await extract.extract_file(
        "manual.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buf.getvalue(),
    )
    assert "bảo trì" in result["text"]
    assert "Thay trục cuốn" in result["tables"][0]["markdown"]


async def test_pdf_with_a_text_layer_is_read():
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "May in bi ket giay.")
    data = doc.tobytes()

    result = await extract.extract_file("manual.pdf", "application/pdf", data)
    assert "ket giay" in result["text"]


async def test_pdf_with_no_text_layer_is_refused_as_unsupported():
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    doc.new_page()  # blank page, no text — the "scanned PDF" shape
    data = doc.tobytes()

    with pytest.raises(HTTPException) as exc:
        await extract.extract_file("scan.pdf", "application/pdf", data)
    assert exc.value.status_code == 415


async def test_corrupt_pdf_is_a_clean_422_not_a_crash():
    with pytest.raises(HTTPException) as exc:
        await extract.extract_file("scan.pdf", "application/pdf", b"%PDF-1.4\n")
    assert exc.value.status_code == 422


async def test_unrecognised_format_is_refused():
    with pytest.raises(HTTPException) as exc:
        await extract.extract_file("photo.png", "image/png", b"\x89PNG\r\n")
    assert exc.value.status_code == 415
