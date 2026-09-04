"""Handover-minutes importer: verification, direction inference, plan, apply.

The LLM is monkeypatched throughout — these tests are about what the importer does
with what it is handed, including being handed something wrong. The fixtures are the
real `ban giao Thanh QC VPHN349.xlsx` flattened the way the browser flattens it, so
the shape under test is the shape that actually arrives.
"""
import json
from datetime import date

import pytest

from be import handover_direction, handover_import, handover_sheet, llm
from be.config import settings
from be.handover_direction import Context, Movement, Party, decide, parse_note_direction
from be.handover_import import ISSUE, RETURN, TRANSFER
from be.repositories import device as device_repo
from be.repositories import user as user_repo
from .conftest import GHOST

# The real record, flattened as `idx | cell | cell` with date cells carrying their
# ISO value in brackets — exactly what ImportHandoverModal sends.
SHEET_ONE_ITEM = """\
  3 | CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM
  4 | Độc lập - Tự do - Hạnh phúc
  5 |  |  |  | Tuesday, July 21, 2026 [2026-07-21]
  7 | BIÊN BẢN BÀN GIAO HANDOVER MINUTES
  8 | 1. Địa điểm/ Place:  | Tầng 05 , tòa nhà IDMC, Công ty TNHH YIC ONE
  9 | 2. Thành phần tham gia/ Parties:
 10 | Bên A/ Party A: | Trịnh Thế Hưng |  | Mã NV/ Code:  | VPHN228
 11 | Bộ phận/Dept.:  | Operation |  | Chức vụ/ Position:  | IT
 12 | Bên B/ Party B: | Bùi Thị Thanh |  | Mã NV/ Code:  | VPHN349
 13 | Bộ phận/ Dept.:  | QA |  | Chức vụ/ Position:  | QC Staff
 14 | 3. Nội dung bàn giao/Contents:
 15 | No. | Nội dung/ Items | Số lượng/ Quantity | Chi tiết/ Detail | SERIAL | Ghi chú/ Note
 16 | 1 | HP laptop | 1 | HP Laptop core i3 ram 8gb SSD 256gb | 5CD03347TB | chuột có dây
 18 | Biên bản giao nhận được lập và có chữ ký của đầy đủ các bên
 21 | Bên A |  |  |  | Bên  B
 22 | Handover |  |  |  | Receiver
"""

# The two-row shape: row 1 the old machine coming back, row 2 the new one going out.
SHEET_TWO_ITEMS = SHEET_ONE_ITEM.replace(
    " 18 | Biên bản",
    " 17 | 2 | Dell laptop | 1 | Dell Latitude core i5 ram 16gb SSD 512gb"
    " | DL-NEW-001 | máy mới\n 18 | Biên bản",
)

READING_ONE_ITEM = {
    "handover_date": "2026-07-21",
    "place": "Tầng 05 , tòa nhà IDMC, Công ty TNHH YIC ONE",
    "parties": [
        {"label": "A", "name": "Trịnh Thế Hưng", "code": "VPHN228",
         "dept": "Operation", "position": "IT"},
        {"label": "B", "name": "Bùi Thị Thanh", "code": "VPHN349",
         "dept": "QA", "position": "QC Staff"},
    ],
    "items": [{
        "no": 1, "item": "HP laptop", "quantity": 1,
        "detail": "HP Laptop core i3 ram 8gb SSD 256gb",
        "serial": "5CD03347TB", "note": "chuột có dây",
        "device": {"type": "Laptop", "brand": "HP", "cpu": "core i3",
                   "ram": "8gb", "storage": "SSD 256gb", "name": "HP laptop"},
    }],
}


# The real `ban giao Dana intern acc.xlsx`: THREE parties, and two rows that move
# between two different pairs — neither of them A↔B. The Ghi chú cell carries the
# direction, which is how the team writes it.
SHEET_THREE_PARTIES = """\
  5 |  |  |  | Saturday, August 08, 2026 [2026-08-08]
  7 | BIÊN BẢN BÀN GIAO HANDOVER MINUTES
  8 | 1. Địa điểm/ Place: | Tầng 05 , tòa nhà IDMC, Công ty TNHH YIC ONE
  9 | 2. Thành phần tham gia/ Parties:
 10 | Bên A/ Party A: | Trịnh Thế Hưng |  | Mã NV/ Code: | VPHN228
 11 | Bộ phận/Dept.: | Operation |  | Chức vụ/ Position: | IT
 12 | Bên B/ Party B: | Đặng Hà Anh |  | Mã NV/ Code: | TTS018
 13 | Bộ phận/ Dept.: | OPD |  | Chức vụ/ Position: | Acc Intern
 14 | Bên C/ Party C: | Naomi |  | Mã NV/ Code: | VPHN271
 15 | Bộ phận/Dept.: | DMD |  | Chức vụ/ Position: | Vuori staff
 16 | 3. Nội dung bàn giao/Contents:
 17 | No. | Nội dung/ Items | Số lượng/ Quantity | Chi tiết/ Detail | SERIAL | Ghi chú/ Note
 18 | 1 | HP laptop | 1 | HP Laptop core i3 ram 8gb SSD 256gb | 5CD33443JJ | 271->TTS018
 19 | 2 | ASUS laptop | 2 | Asus laptop ryzen 5 ram 16gb ssd 512gb | W5N0CV08Z072214 | 228->271
 20 | Biên bản giao nhận được lập và có chữ ký của đầy đủ các bên
"""

READING_THREE_PARTIES = {
    "handover_date": "2026-08-08",
    "place": "Tầng 05 , tòa nhà IDMC, Công ty TNHH YIC ONE",
    "parties": [
        {"label": "A", "name": "Trịnh Thế Hưng", "code": "VPHN228",
         "dept": "Operation", "position": "IT"},
        {"label": "B", "name": "Đặng Hà Anh", "code": "TTS018",
         "dept": "OPD", "position": "Acc Intern"},
        {"label": "C", "name": "Naomi", "code": "VPHN271",
         "dept": "DMD", "position": "Vuori staff"},
    ],
    "items": [
        {"no": 1, "item": "HP laptop", "quantity": 1,
         "detail": "HP Laptop core i3 ram 8gb SSD 256gb",
         "serial": "5CD33443JJ", "note": "271->TTS018",
         "device": {"type": "laptop", "brand": "HP", "cpu": "core i3",
                    "ram": "8gb", "storage": "SSD 256gb", "name": "HP laptop"}},
        {"no": 2, "item": "ASUS laptop", "quantity": 2,
         "detail": "Asus laptop ryzen 5 ram 16gb ssd 512gb",
         "serial": "W5N0CV08Z072214", "note": "228->271",
         "device": {"type": "laptop", "brand": "Asus", "cpu": "ryzen 5",
                    "ram": "16gb", "storage": "ssd 512gb", "name": "ASUS laptop"}},
    ],
}

# The same three, as the resolver framework sees them.
DANA = (
    Party("A", "VPHN228", "Trịnh Thế Hưng", "Operation", "IT"),
    Party("B", "TTS018", "Đặng Hà Anh", "OPD", "Acc Intern"),
    Party("C", "VPHN271", "Naomi", "DMD", "Vuori staff"),
)
# The ordinary two-party record, for the regression cases.
PAIR = (
    Party("A", "VPHN228", "Trịnh Thế Hưng", "Operation", "IT"),
    Party("B", "VPHN349", "Bùi Thị Thanh", "QA", "QC Staff"),
)


def _ai_on(monkeypatch):
    """Switch the model paths back on for one test.

    `settings.ai_enabled` is FALSE in the deployed configuration — the model server
    was retired — and every LLM call site is guarded by it. A test about what those
    call sites do when a model IS available has to say so, or it passes without ever
    running the code it is named after.
    """
    monkeypatch.setattr(settings, "ai_enabled", True)


def _fake_llm(monkeypatch, reading: dict):
    """Make the LLM answer with a canned reading — no model is contacted.

    Both transports are patched, because the reader has two: `/read` drains the same
    generator `/read/stream` forwards, and that generator streams. The fake stream
    deliberately splits the JSON mid-string rather than yielding it whole — that is
    the shape the real one arrives in, and it is what the progress counter has to
    survive (`"serial"` routinely straddles two chunks).

    Implies `_ai_on` — a canned reading is worthless if the guard skips the call.
    """
    _ai_on(monkeypatch)

    async def _chat(system, user, **kwargs):
        return json.dumps(reading)

    async def _chat_stream(system, user, **kwargs):
        raw = json.dumps(reading)
        for i in range(0, len(raw), 7):
            yield raw[i:i + 7]

    monkeypatch.setattr(llm, "_chat", _chat)
    monkeypatch.setattr(llm, "_chat_stream", _chat_stream)


def _events(text: str) -> list[dict]:
    """An SSE body → the events it carries. Both `/detect/stream` and
    `/handover/read/stream` are asserted through this."""
    return [
        json.loads(chunk[len("data: "):])
        for chunk in text.split("\n\n")
        if chunk.startswith("data: ")
    ]


DEVICE_SHEET = """\
  1 | Serial Number | Brand | Type | CPU | RAM | Storage | OS | Buy date | Owner
  2 | 5CD03347TB | HP | Laptop | core i3 | 8gb | SSD 256gb | Windows 10 | 2024-03-15 | VPHN349
"""

MAINTENANCE_SHEET = """\
  1 | Serial | Ngày sửa | Hạng mục | Lý do | Cách xử lý | Kết quả | Chi phí
  2 | 5CD03347TB | 2026-03-01 | RAM | Máy chậm | Thêm RAM | Nhanh hơn | 300000
"""


# ------------------------------------------------------------------ /detect

async def test_detect_handover_without_asking_the_llm(client, monkeypatch):
    _ai_on(monkeypatch)  # a model IS available here; the point is that it is not asked

    async def _boom(*a, **k):  # noqa: ANN002
        raise AssertionError("heuristics should have settled this")
    monkeypatch.setattr(llm, "_chat", _boom)

    r = await client.post("/imports/detect", json={"sheet_text": SHEET_ONE_ITEM})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "handover_minutes"
    assert body["confident"] is True
    assert body["used_llm"] is False
    assert "bien ban ban giao" in body["reason"].lower()


async def test_detect_device_and_maintenance_sheets_by_header(client, monkeypatch):
    _ai_on(monkeypatch)  # a model IS available here; the point is that it is not asked

    async def _boom(*a, **k):  # noqa: ANN002
        raise AssertionError("heuristics should have settled this")
    monkeypatch.setattr(llm, "_chat", _boom)

    devices = (await client.post(
        "/imports/detect", json={"sheet_text": DEVICE_SHEET}
    )).json()
    assert (devices["kind"], devices["used_llm"]) == ("device_list", False)

    maint = (await client.post(
        "/imports/detect", json={"sheet_text": MAINTENANCE_SHEET}
    )).json()
    assert (maint["kind"], maint["used_llm"]) == ("maintenance_list", False)


async def test_detect_stream_reports_its_phases(client, monkeypatch):
    """A queue row has to be able to say what it is waiting on. The heuristics settle
    a template sheet outright, so the model phase never appears."""
    _ai_on(monkeypatch)  # a model IS available here; the point is that it is not asked

    async def _boom(*a, **k):  # noqa: ANN002
        raise AssertionError("heuristics should have settled this")
    monkeypatch.setattr(llm, "_chat", _boom)

    r = await client.post(
        "/imports/detect/stream", json={"sheet_text": SHEET_ONE_ITEM}
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    events = _events(r.text)
    assert [e["phase"] for e in events] == ["matching", "done"]
    assert events[-1]["result"]["kind"] == "handover_minutes"
    assert events[-1]["result"]["used_llm"] is False


async def test_detect_stream_names_the_model_phase_when_it_is_used(client, monkeypatch):
    _fake_llm(monkeypatch, {"kind": "device_list", "reason": "Toàn serial máy."})
    r = await client.post(
        "/imports/detect/stream",
        json={"sheet_text": "một hàng chữ chẳng nói lên điều gì"},
    )
    events = _events(r.text)
    assert [e["phase"] for e in events] == ["matching", "asking", "done"]
    assert events[-1]["result"]["used_llm"] is True


async def test_detect_stream_delivers_a_failure_as_an_event(client):
    """Same reason as the read stream: the 200 is spent by the time this runs."""
    r = await client.post("/imports/detect/stream", json={})
    assert r.status_code == 200
    last = _events(r.text)[-1]
    assert (last["phase"], last["status"]) == ("error", 400)


async def test_detect_falls_back_to_the_llm_when_unsure(client, monkeypatch):
    _fake_llm(monkeypatch, {"kind": "device_list", "reason": "Toàn serial máy."})
    r = await client.post(
        "/imports/detect", json={"sheet_text": "một hàng chữ chẳng nói lên điều gì"}
    )
    body = r.json()
    assert body["kind"] == "device_list"
    assert body["used_llm"] is True


async def test_detect_rejects_a_kind_outside_the_allow_list(client, monkeypatch):
    _fake_llm(monkeypatch, {"kind": "invoices", "reason": "Hoá đơn."})
    body = (await client.post(
        "/imports/detect", json={"sheet_text": "không rõ là gì"}
    )).json()
    assert body["kind"] == "unknown"
    assert body["confident"] is False


async def test_detect_says_unknown_when_the_llm_is_down(client, monkeypatch):
    _ai_on(monkeypatch)

    async def _chat(*a, **k):  # noqa: ANN002
        return "not json"
    monkeypatch.setattr(llm, "_chat", _chat)
    body = (await client.post(
        "/imports/detect", json={"sheet_text": "không rõ là gì"}
    )).json()
    # Never a hard failure: the drop zone just asks the user to pick.
    assert body["kind"] == "unknown"


# ------------------------------------------------------------- verify_parsed

def test_verify_keeps_what_the_file_contains():
    parsed, warnings = handover_import.verify_parsed(READING_ONE_ITEM, SHEET_ONE_ITEM)
    assert parsed["handover_date"] == "2026-07-21"
    party_a, party_b = parsed["parties"]
    assert party_a["code"] == "VPHN228"
    assert party_b["name"] == "Bùi Thị Thanh"
    assert party_b["dept"] == "QA"
    assert party_a["position"] == "IT"
    assert [i["serial"] for i in parsed["items"]] == ["5CD03347TB"]
    # "Laptop" vs the sheet's "laptop" — case and diacritics are folded, not rejected.
    assert parsed["items"][0]["device"]["type"] == "Laptop"
    assert parsed["items"][0]["device"]["cpu"] == "core i3"
    assert warnings == []


def test_verify_drops_an_invented_serial():
    reading = json.loads(json.dumps(READING_ONE_ITEM))
    reading["items"][0]["serial"] = "SN-DOES-NOT-EXIST"
    parsed, warnings = handover_import.verify_parsed(reading, SHEET_ONE_ITEM)
    assert parsed["items"] == []
    assert any("SERIAL" in w for w in warnings)


def test_verify_drops_an_invented_field_but_keeps_the_row():
    reading = json.loads(json.dumps(READING_ONE_ITEM))
    reading["items"][0]["device"]["cpu"] = "Core i9"       # not in the file
    reading["parties"][1]["dept"] = "Marketing"            # not in the file
    parsed, warnings = handover_import.verify_parsed(reading, SHEET_ONE_ITEM)
    assert parsed["items"][0]["device"]["cpu"] is None
    assert parsed["items"][0]["serial"] == "5CD03347TB"
    assert parsed["parties"][1]["dept"] is None
    assert len(warnings) == 2


def test_verify_keeps_every_party_a_record_carries():
    """The bug this whole change exists for: Bên C used to be dropped on the floor
    because the shape had room for exactly two."""
    parsed, warnings = handover_import.verify_parsed(
        READING_THREE_PARTIES, SHEET_THREE_PARTIES
    )
    assert [p["label"] for p in parsed["parties"]] == ["A", "B", "C"]
    assert [p["code"] for p in parsed["parties"]] == ["VPHN228", "TTS018", "VPHN271"]
    assert parsed["parties"][2]["name"] == "Naomi"
    assert warnings == []


def test_verify_drops_a_party_the_model_padded_the_list_with():
    reading = json.loads(json.dumps(READING_THREE_PARTIES))
    reading["parties"].append(
        {"label": "D", "name": "Không Có Ai", "code": "VPHN999",
         "dept": None, "position": None}
    )
    parsed, warnings = handover_import.verify_parsed(reading, SHEET_THREE_PARTIES)
    assert [p["label"] for p in parsed["parties"]] == ["A", "B", "C"]
    assert any("Bỏ qua Bên D" in w for w in warnings)


def test_verify_numbers_movements_by_position_not_serial():
    """One record can move the same device twice. `row` is what tells the two
    movements apart — the serial cannot."""
    reading = json.loads(json.dumps(READING_ONE_ITEM))
    reading["items"].append(json.loads(json.dumps(reading["items"][0])))
    parsed, _ = handover_import.verify_parsed(reading, SHEET_ONE_ITEM)
    assert [i["row"] for i in parsed["items"]] == [1, 2]
    assert [i["serial"] for i in parsed["items"]] == ["5CD03347TB", "5CD03347TB"]


def test_verify_rejects_a_date_no_cell_supports():
    reading = json.loads(json.dumps(READING_ONE_ITEM))
    reading["handover_date"] = "2026-08-04"  # the entry date, not the file's date
    parsed, warnings = handover_import.verify_parsed(reading, SHEET_ONE_ITEM)
    assert parsed["handover_date"] is None
    assert any("2026-08-04" in w for w in warnings)


# --------------------------------------------------------------- detect_it_side

def test_it_side_from_position_and_stored_team():
    index, reason = handover_import.detect_it_side(
        READING_ONE_ITEM["parties"],
        [{"employee_code": "VPHN228", "team": "IT"},
         {"employee_code": "VPHN349", "team": None}],
    )
    assert index == 0
    assert "IT" in reason


def test_no_it_side_when_no_party_is_it():
    index, _ = handover_import.detect_it_side(
        [{"dept": "QA", "position": "QC Staff"},
         {"dept": "TECH", "position": "Engineer"}],
        [None, None],
    )
    assert index is None


def test_it_side_is_found_among_three_parties():
    index, reason = handover_import.detect_it_side(
        READING_THREE_PARTIES["parties"], [None, None, None]
    )
    assert index == 0
    assert "Bên A" in reason


def test_it_side_is_found_among_four_parties():
    parties = READING_THREE_PARTIES["parties"] + [
        {"label": "D", "code": "VPHN400", "dept": "SALES", "position": "Staff"}
    ]
    index, _ = handover_import.detect_it_side(parties, [None] * 4)
    assert index == 0


def test_two_it_looking_parties_settle_nothing():
    index, reason = handover_import.detect_it_side(
        [{"label": "A", "position": "IT"},
         {"label": "B", "position": "QC"},
         {"label": "C", "dept": "IT"}],
        [None, None, None],
    )
    assert index is None
    assert "nhiều bên" in reason.lower()


def test_unit_is_not_it():
    # Token match, so a department named "UNIT" must not read as IT.
    assert handover_import._looks_it("UNIT") is False
    assert handover_import._looks_it("IT Support") is True


# --------------------------------------------------- the note arrow, on its own

@pytest.mark.parametrize(
    ("note", "expected"),
    [
        # How the team actually writes it: the trailing digits of a code.
        ("271->TTS018", ("VPHN271", "TTS018")),
        ("228->271", ("VPHN228", "VPHN271")),
        # Full codes, party letters, and the other arrows a keyboard produces.
        ("VPHN228->VPHN271", ("VPHN228", "VPHN271")),
        ("A -> C", ("VPHN228", "VPHN271")),
        ("B → A", ("TTS018", "VPHN228")),
        ("VPHN228 --> TTS018", ("VPHN228", "TTS018")),
        # The expression is what counts; the prose around it is not in the way.
        ("máy cũ 271 -> TTS018 nhận", ("VPHN271", "TTS018")),
        # And everything that is NOT a direction stays out of the way entirely.
        ("chuột có dây", None),
        ("máy mới", None),
        (None, None),
        ("", None),
        ("A->B->C", None),          # two movements on one line — a human decides
        ("271->VPHN271", None),     # both ends the same party
        ("999->271", None),         # nothing answers to 999
        ("->271", None),
    ],
)
def test_parse_note_direction(note, expected):
    assert parse_note_direction(note, DANA) == expected


def test_an_ambiguous_token_is_no_evidence_at_all():
    """Two parties whose codes both end in the token — picking one would be a
    coin flip, so the note is dropped and the next resolver gets its turn."""
    twins = (Party("A", "VPHN271"), Party("B", "TTS271"), Party("C", "VPHN228"))
    assert parse_note_direction("271->VPHN228", twins) is None


# --------------------------------------------------- two parties, unchanged

def test_new_device_is_a_hand_out():
    d = decide(Context(PAIR, "VPHN228", None, ()), Movement(1, "DL-NEW-001"))
    assert d["flow"] == ISSUE
    assert (d["from_user_id"], d["to_user_id"]) == ("VPHN228", "VPHN349")
    assert d["device_owner_after"] == "VPHN349"
    assert d["device_status_after"] == "active"
    assert d["ambiguous"] is False


def test_device_the_person_once_held_is_a_return():
    # The real 5CD03347TB case: parked on IT-STORE now, but VPHN349 appears in its
    # history, so it is her old machine coming back — not a fresh hand-out.
    d = decide(
        Context(
            PAIR, "VPHN228",
            {"serial_number": "5CD03347TB", "user_id": GHOST, "status": "in_stock"},
            ({"handover_id": "h1", "handover_date": "2026-01-05",
              "from_user_id": "VPHN266", "to_user_id": "VPHN349"},),
        ),
        Movement(1, "5CD03347TB"),
    )
    assert d["flow"] == RETURN
    assert (d["from_user_id"], d["to_user_id"]) == ("VPHN349", "VPHN228")
    assert d["device_owner_after"] == GHOST
    assert d["device_status_after"] == "in_stock"


def test_owner_without_history_is_ambiguous():
    d = decide(
        Context(PAIR, "VPHN228", {"user_id": "VPHN349", "status": "active"}, ()),
        Movement(1, "5CD03347TB"),
    )
    assert d["ambiguous"] is True
    assert d["flow"] == RETURN


def test_third_party_owner_is_ambiguous():
    d = decide(
        Context(PAIR, "VPHN228", {"user_id": "VPHN216", "status": "active"}, ()),
        Movement(1, "5CD03347TB"),
    )
    assert d["ambiguous"] is True
    assert "VPHN216" in d["flow_reason"]


def test_already_recorded_handover_is_not_reversed():
    """The re-import trap: a hand-out that was applied leaves the device on the
    receiver, which the prior-holder resolver would otherwise read as a return."""
    history = ({"handover_id": "h1", "handover_date": "2026-07-21",
                "from_user_id": "VPHN228", "to_user_id": "VPHN349"},)
    d = decide(
        Context(PAIR, "VPHN228", {"user_id": "VPHN349", "status": "active"}, history),
        Movement(1, "5CD03347TB"),
    )
    assert d["duplicate_of"] == history[0]
    assert d["flow"] == ISSUE
    assert (d["from_user_id"], d["to_user_id"]) == ("VPHN228", "VPHN349")


def test_no_it_side_is_a_transfer():
    pair = (Party("A", "VPHN216"), Party("B", "VPHN258"))
    d = decide(
        Context(pair, None, {"user_id": "VPHN258", "status": "active"}, ()),
        Movement(1, "SN-1"),
    )
    assert d["flow"] == TRANSFER
    # Whoever holds it is the one giving it away.
    assert (d["from_user_id"], d["to_user_id"]) == ("VPHN258", "VPHN216")


def test_maintaining_device_keeps_its_status_on_return():
    d = decide(
        Context(PAIR, "VPHN228", {"user_id": "VPHN349", "status": "maintaining"},
                ({"from_user_id": GHOST, "to_user_id": "VPHN349"},)),
        Movement(1, "5CD03347TB"),
    )
    assert d["flow"] == RETURN
    assert d["device_status_after"] == "maintaining"


# ------------------------------------------------ order, and three-party records

def test_a_recorded_handover_outranks_a_contradicting_note():
    """What the ledger already did beats what the paper says it would do —
    otherwise a re-import reverses ownership on the strength of a note."""
    history = ({"handover_id": "h1", "handover_date": "2026-08-08",
                "from_user_id": "VPHN228", "to_user_id": "VPHN271"},)
    d = decide(
        Context(DANA, "VPHN228", {"user_id": "VPHN271", "status": "active"}, history),
        Movement(2, "W5N0CV08Z072214", "271->228"),
    )
    assert d["direction_source"] == "recorded"
    assert (d["from_user_id"], d["to_user_id"]) == ("VPHN228", "VPHN271")


def test_a_note_outranks_the_ledgers_inference():
    """VPHN349 has held this machine, so the prior-holder resolver would call it a
    return. The note says otherwise, and an explicitly written direction wins."""
    d = decide(
        Context(PAIR, "VPHN228", {"user_id": GHOST, "status": "in_stock"},
                ({"from_user_id": "VPHN266", "to_user_id": "VPHN349"},)),
        Movement(1, "5CD03347TB", "228->349"),
    )
    assert d["direction_source"] == "note"
    assert (d["from_user_id"], d["to_user_id"]) == ("VPHN228", "VPHN349")
    assert d["flow"] == ISSUE


def test_the_dana_record_row_by_row():
    """Both rows of `ban giao Dana intern acc.xlsx`, against the live ledger's own
    state. Neither moves between Bên A and Bên B."""
    hp = decide(
        Context(DANA, "VPHN228",
                {"serial_number": "5CD33443JJ", "user_id": "VPHN271",
                 "status": "active"}, ()),
        Movement(1, "5CD33443JJ", "271->TTS018"),
    )
    assert (hp["from_user_id"], hp["to_user_id"]) == ("VPHN271", "TTS018")
    assert hp["device_owner_after"] == "TTS018"
    assert hp["flow"] == TRANSFER      # neither end is IT
    assert hp["confident"] is True

    asus = decide(
        Context(DANA, "VPHN228", None, ()),
        Movement(2, "W5N0CV08Z072214", "228->271"),
    )
    assert (asus["from_user_id"], asus["to_user_id"]) == ("VPHN228", "VPHN271")
    assert asus["device_owner_after"] == "VPHN271"
    assert asus["flow"] == ISSUE
    assert asus["confident"] is True


def test_three_parties_with_nothing_to_go_on_ask_instead_of_guessing():
    """The row-2 bug. A new device and an IT side used to be the *confident* common
    case, so the ASUS was created under whichever party happened to be second — the
    intern. With three parties there is no counterpart to assume."""
    d = decide(Context(DANA, "VPHN228", None, ()), Movement(2, "W5N0CV08Z072214"))
    assert d["direction_source"] == "unknown"
    assert d["confident"] is False
    assert (d["from_user_id"], d["to_user_id"]) == (None, None)


def test_a_stranger_holding_it_is_not_handed_to_an_arbitrary_party():
    d = decide(
        Context(DANA, "VPHN228", {"user_id": "VPHN999", "status": "active"}, ()),
        Movement(1, "SN-1"),
    )
    assert d["confident"] is False
    assert d["to_user_id"] is None


def test_four_parties_and_three_disjoint_movements():
    """The generality claim, exercised rather than asserted."""
    parties = DANA + (Party("D", "VPHN400", "Ai Đó", "SALES", "Staff"),)
    ctx = lambda device: Context(parties, "VPHN228", device, ())  # noqa: E731
    moves = [
        (Movement(1, "S1", "228->271"), ("VPHN228", "VPHN271")),
        (Movement(2, "S2", "271->TTS018"), ("VPHN271", "TTS018")),
        (Movement(3, "S3", "D->B"), ("VPHN400", "TTS018")),
    ]
    for movement, expected in moves:
        d = decide(ctx(None), movement)
        assert (d["from_user_id"], d["to_user_id"]) == expected
        assert d["confident"] is True


# ------------------------------------------------------------------- /read

async def test_read_returns_verified_fields(client, monkeypatch):
    _fake_llm(monkeypatch, READING_ONE_ITEM)
    r = await client.post("/imports/handover/read", json={"sheet_text": SHEET_ONE_ITEM})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [p["code"] for p in body["parsed"]["parties"]] == ["VPHN228", "VPHN349"]
    assert body["warnings"] == []


async def test_read_does_not_touch_the_model_for_a_template_sheet(client, monkeypatch):
    """The company template is a form, not a judgement call. Measured against the
    live llama3.1:8b, letting the model read it costs ~25s warm and ~70s cold for a
    fifteen-row record; the parser costs under a millisecond. So the model is not
    asked, and this test fails loudly if that regresses."""
    _ai_on(monkeypatch)  # a model IS available here; the point is that it is not asked

    async def _boom(*a, **k):  # noqa: ANN002
        raise AssertionError("a template sheet must not reach the model")
    monkeypatch.setattr(llm, "_chat", _boom)
    monkeypatch.setattr(llm, "_chat_stream", _boom)

    r = await client.post("/imports/handover/read", json={"sheet_text": SHEET_ONE_ITEM})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reader"] == "sheet"
    assert body["item_rows"] == 1
    assert body["warnings"] == []
    item = body["parsed"]["items"][0]
    assert item["serial"] == "5CD03347TB"
    assert item["note"] == "chuột có dây"
    # The spec split the model used to be asked for, done in plain code.
    assert item["device"] == {
        "type": "Laptop", "brand": "HP", "cpu": "core i3",
        "ram": "8gb", "storage": "SSD 256gb", "name": "HP laptop",
    }


async def test_read_falls_back_to_the_model_off_template(client, monkeypatch):
    """A scan or a photo arrives with no columns left. The parser declines rather
    than guessing, and the model takes it."""
    _fake_llm(monkeypatch, READING_ONE_ITEM)
    prose = (
        "BIÊN BẢN BÀN GIAO HANDOVER MINUTES ngày 2026-07-21 tại Tầng 05 , tòa nhà "
        "IDMC, Công ty TNHH YIC ONE. Bên A Trịnh Thế Hưng VPHN228 Operation IT. "
        "Bên B Bùi Thị Thanh VPHN349 QA QC Staff. HP laptop, "
        "HP Laptop core i3 ram 8gb SSD 256gb, 5CD03347TB, chuột có dây."
    )
    assert handover_sheet.read_sheet(prose) is None

    r = await client.post("/imports/handover/read", json={"sheet_text": prose})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reader"] == "llm"
    assert [p["code"] for p in body["parsed"]["parties"]] == ["VPHN228", "VPHN349"]


async def test_read_can_be_forced_onto_the_model(client, monkeypatch):
    """The "read again with AI" escape hatch: a sheet the parser CAN read, read by
    the model instead, because a changed template could parse into something subtly
    wrong and one button is a better answer than a bug report."""
    reading = json.loads(json.dumps(READING_ONE_ITEM))
    reading["place"] = None
    _fake_llm(monkeypatch, reading)
    r = await client.post(
        "/imports/handover/read",
        json={"sheet_text": SHEET_ONE_ITEM, "reader": "llm"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["reader"] == "llm"
    assert r.json()["parsed"]["place"] is None  # the model's answer, not the parse


async def test_read_503s_when_the_model_is_unusable(client, monkeypatch):
    _ai_on(monkeypatch)

    async def _chat(system, user, **kwargs):
        return "not json at all"

    async def _chat_stream(system, user, **kwargs):
        yield "not json at all"

    monkeypatch.setattr(llm, "_chat", _chat)
    monkeypatch.setattr(llm, "_chat_stream", _chat_stream)
    # Forced onto the model, since the parser would otherwise read this one itself.
    r = await client.post(
        "/imports/handover/read",
        json={"sheet_text": SHEET_ONE_ITEM, "reader": "llm"},
    )
    assert r.status_code == 503
    assert "AI" in r.json()["detail"]


async def test_read_needs_a_source(client):
    r = await client.post("/imports/handover/read", json={})
    assert r.status_code == 400


# ------------------------------------------------------------ /read/stream

async def test_read_stream_reports_each_phase_and_ends_with_the_result(client):
    r = await client.post(
        "/imports/handover/read/stream", json={"sheet_text": SHEET_TWO_ITEMS}
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")

    events = _events(r.text)
    assert [e["phase"] for e in events] == ["scanning", "verifying", "done"]
    # The denominator is read off the file's own table before anything else runs,
    # which is what lets the bar say "1 of 2" instead of animating.
    assert events[0]["total"] == 2
    result = events[-1]["result"]
    assert result["reader"] == "sheet"
    assert result["item_rows"] == 2
    assert [i["serial"] for i in result["parsed"]["items"]] == [
        "5CD03347TB", "DL-NEW-001",
    ]


async def test_read_stream_counts_rows_as_the_model_writes_them(client, monkeypatch):
    """The progress that is actually counted. Two items, so the model emits two
    `"serial"` keys and the stream reports 1 then 2 — across chunk boundaries that
    split those keys in half."""
    reading = json.loads(json.dumps(READING_THREE_PARTIES))
    _fake_llm(monkeypatch, reading)
    r = await client.post(
        "/imports/handover/read/stream",
        json={"sheet_text": SHEET_THREE_PARTIES, "reader": "llm"},
    )
    events = _events(r.text)
    phases = [e["phase"] for e in events]
    assert phases[0] == "scanning"
    assert "loading" in phases  # the ~44s of silence, named rather than hidden
    assert [e["items"] for e in events if e["phase"] == "reading"] == [1, 2]
    assert events[-1]["result"]["reader"] == "llm"


async def test_read_stream_delivers_a_failure_as_an_event(client, monkeypatch):
    """The 200 was sent before the read began, so a failure cannot be a status code
    any more — it has to arrive as an event or the screen waits forever."""
    _ai_on(monkeypatch)

    async def _chat_stream(system, user, **kwargs):
        yield "not json at all"

    monkeypatch.setattr(llm, "_chat_stream", _chat_stream)
    r = await client.post(
        "/imports/handover/read/stream",
        json={"sheet_text": SHEET_ONE_ITEM, "reader": "llm"},
    )
    assert r.status_code == 200
    last = _events(r.text)[-1]
    assert last["phase"] == "error"
    assert last["status"] == 503


async def test_warm_never_fails_the_caller(client, monkeypatch):
    """A cold model is a slow import, not a broken one."""
    _ai_on(monkeypatch)

    async def _dead():
        return False
    monkeypatch.setattr(llm, "warm", _dead)
    r = await client.post("/imports/llm/warm")
    assert r.status_code == 200
    assert r.json() == {"warm": False}


# ------------------------------------------------ with AI switched off (default)
#
# settings.ai_enabled is FALSE in the deployed configuration: the local model
# server was retired. These are the cases that matter day to day, so they say what
# happens rather than leaving it to be inferred from the guarded branches above.
# Note none of them touch monkeypatch — the default IS off, and a test that had to
# arrange that would stop noticing if the default flipped back.


async def test_template_sheet_still_reads_with_no_model_at_all(client):
    """The one path that has to keep working. The company template is a form, and
    handover_sheet parses it in plain code — no model was ever involved."""
    r = await client.post("/imports/handover/read", json={"sheet_text": SHEET_ONE_ITEM})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reader"] == "sheet"
    assert body["parsed"]["items"][0]["serial"] == "5CD03347TB"


async def test_off_template_text_is_refused_as_off_template_not_as_an_outage(client):
    """Prose used to fall through to the model. With no model the honest answer is
    about the FILE — telling someone the AI is down invites them to retry forever."""
    prose = (
        "BIÊN BẢN BÀN GIAO ngày 2026-07-21. Bên A Trịnh Thế Hưng VPHN228. "
        "Bên B Bùi Thị Thanh VPHN349. HP laptop 5CD03347TB."
    )
    assert handover_sheet.read_sheet(prose) is None

    r = await client.post("/imports/handover/read", json={"sheet_text": prose})
    assert r.status_code == 422
    assert "mẫu" in r.json()["detail"]


async def test_forcing_the_model_falls_back_to_the_parser_instead_of_failing(client):
    """A stale SPA can still send reader="llm". Honouring it would skip the only
    reader that works and then report the file as off-template, which is a lie about
    a file that reads fine."""
    r = await client.post(
        "/imports/handover/read",
        json={"sheet_text": SHEET_ONE_ITEM, "reader": "llm"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["reader"] == "sheet"


async def test_detect_settles_on_the_heuristics_without_a_model(client, monkeypatch):
    """The unsure branch used to ask the model. It must not now try and hang."""
    async def _boom(*a, **k):  # noqa: ANN002
        raise AssertionError("no model should be contacted while AI is off")
    monkeypatch.setattr(llm, "_chat", _boom)

    body = (await client.post(
        "/imports/detect", json={"sheet_text": "một hàng chữ chẳng nói lên điều gì"}
    )).json()
    assert body["used_llm"] is False
    assert body["confident"] is False


async def test_warm_answers_without_reaching_for_a_model(client, monkeypatch):
    """Kept as a 200 rather than deleted so a cached SPA build gets an answer, not a
    404 in its console."""
    async def _boom():
        raise AssertionError("warm must not contact a model while AI is off")
    monkeypatch.setattr(llm, "warm", _boom)

    r = await client.post("/imports/llm/warm")
    assert r.status_code == 200
    assert r.json() == {"warm": False}


async def test_extracting_a_pdf_says_what_still_works(client):
    """A PDF has no reader without OCR. The message names the Excel template rather
    than a service the user has never heard of."""
    r = await client.post(
        "/imports/handover/read",
        json={"attachment": {"name": "scan.pdf", "mime": "application/pdf",
                             "data": "JVBERi0xLjQK"}},
    )
    assert r.status_code == 503
    assert "Excel" in r.json()["detail"]


# ------------------------------------------------------------------- /plan

@pytest.fixture
async def parsed_one_item(client, monkeypatch):
    _fake_llm(monkeypatch, READING_ONE_ITEM)
    r = await client.post("/imports/handover/read", json={"sheet_text": SHEET_ONE_ITEM})
    return r.json()["parsed"]


async def test_plan_reconciles_people_and_the_device(client, seed, parsed_one_item):
    r = await client.post("/imports/handover/plan", json={"parsed": parsed_one_item})
    assert r.status_code == 200, r.text
    plan = r.json()

    assert plan["it_index"] == 0
    assert plan["it_code"] == "VPHN228"

    party_a, party_b = plan["parties"]
    # Seeded VPHN228 has team "IT"; the minutes say his department is Operation.
    # That genuinely contradicts, so it needs a human — nothing is auto-filled,
    # because his name already matches and Chức vụ is no longer stored.
    assert party_a["action"] == "update"
    conflict = next(i for i in party_a["issues"] if i["kind"] == "user_field_conflict")
    changed = {f["field"]: f["proposed"] for f in conflict["payload"]["fields"]}
    assert changed == {"team": "Operation"}
    assert party_a["fills"] == {}

    # VPHN349 isn't in the ledger at all. Creating them is the outcome, not a
    # question — nothing goes to the Notifications backlog.
    assert party_b["action"] == "create"
    assert party_b["issues"] == []
    assert party_b["fills"]["name"] == "Bùi Thị Thanh"

    item = plan["items"][0]
    assert item["flow"] == ISSUE          # unknown serial, nobody has held it
    assert item["device_action"] == "create"
    missing = next(
        i for i in item["issues"] if i["kind"] == "device_created_incomplete"
    )
    assert set(missing["payload"]["missing"]) == {"barcode", "buy_date", "os", "msoffice"}


async def test_plan_flags_a_namesake_under_another_code(client, pool, parsed_one_item):
    await pool.execute(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        "VHPN351", "Bùi Thị Thanh", "QA/QC",
    )
    r = await client.post("/imports/handover/plan", json={"parsed": parsed_one_item})
    party_b = r.json()["parties"][1]
    issue = next(i for i in party_b["issues"] if i["kind"] == "user_code_mismatch")
    assert [c["employee_code"] for c in issue["payload"]["candidates"]] == ["VHPN351"]
    # Never merged silently — the plan still creates VPHN349.
    assert party_b["action"] == "create"


async def test_plan_flags_a_namesake_even_when_the_code_exists(client, pool, parsed_one_item):
    """The live VPHN349 / VHPN351 case: both are "Bùi Thị Thanh", the second with a
    transposed prefix. The code in the minutes exists, so the field-conflict branch
    runs — the duplicate person still has to be reported."""
    await pool.executemany(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        [("VPHN349", "Bùi Thị Thanh", "QA/QC"), ("VHPN351", "Bùi Thị Thanh", "QA/QC")],
    )
    r = await client.post("/imports/handover/plan", json={"parsed": parsed_one_item})
    party_b = r.json()["parties"][1]
    issue = next(i for i in party_b["issues"] if i["kind"] == "user_code_mismatch")
    assert [c["employee_code"] for c in issue["payload"]["candidates"]] == ["VHPN351"]


async def test_plan_ignores_a_namesake_whose_code_is_nothing_like_it(
    client, pool, parsed_one_item
):
    """An intern keeps TTS0xx and gains VPHNxxx — fifteen such pairs are in the live
    ledger and none of them is a typo. Two unrelated codes are two records, and
    saying otherwise on every import is what buried the Notifications screen."""
    await pool.execute(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        "TTS004", "Bùi Thị Thanh", "QA/QC",
    )
    r = await client.post("/imports/handover/plan", json={"parsed": parsed_one_item})
    party_b = r.json()["parties"][1]
    assert not any(i["kind"] == "user_code_mismatch" for i in party_b["issues"])


async def test_plan_suggests_the_team_spelling_already_in_use(client, pool, parsed_one_item):
    await pool.execute(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        "VPHN999", "Ai Đó", "QA/QC",
    )
    r = await client.post("/imports/handover/plan", json={"parsed": parsed_one_item})
    party_b = r.json()["parties"][1]
    assert party_b["proposed"]["team"] == "QA"
    assert party_b["team_suggestion"] == "QA/QC"
    # A blank filled with the spelling already in use, not a second spelling.
    assert party_b["fills"]["team"] == "QA/QC"


async def test_plan_fills_a_blank_column_without_asking(client, pool, parsed_one_item):
    """35 people in the live ledger have no department. An empty column is not a
    disagreement — filling it must not cost the team a notification."""
    await pool.execute(
        "INSERT INTO users (employee_code, name) VALUES ($1,$2)",
        "VPHN349", "Bùi Thị Thanh",
    )
    r = await client.post("/imports/handover/plan", json={"parsed": parsed_one_item})
    party_b = r.json()["parties"][1]
    assert party_b["issues"] == []
    assert party_b["fills"] == {"team": "QA"}
    assert party_b["action"] == "update"


# --- "return to IT" means the store, not the IT staffer --------------------

IT_STAFF = {"employee_code": "VPHN229", "name": "Vũ Nhật Minh", "team": "IT"}
NOT_IT = {"employee_code": "VPHN301", "name": "Ai Đó", "team": "SALES 1"}


@pytest.mark.parametrize(
    ("reason", "to_user_id", "to_user", "expected"),
    [
        # Landing on IT with a return-shaped reason → the store.
        ("Return to IT", "VPHN229", IT_STAFF, GHOST),
        ("Resignation Return", "VPHN229", IT_STAFF, GHOST),
        ("Replacement", "VPHN229", IT_STAFF, GHOST),
        ("Trả về kho IT", "VPHN229", IT_STAFF, GHOST),
        ("thu hồi máy", "VPHN229", IT_STAFF, GHOST),
        # Same reason word, but going OUT to a real person — this is the one a
        # reason-only rule would have broken. VPHN229 → VPHN301 "Replacement" is
        # IT issuing a replacement, not collecting one.
        ("Replacement", "VPHN301", NOT_IT, "VPHN301"),
        ("Return to IT", "VPHN301", NOT_IT, "VPHN301"),
        # IT genuinely being issued their own machine.
        ("New Assignment", "VPHN229", IT_STAFF, "VPHN229"),
        # Already the store, and the unknown-recipient case.
        ("Return to IT", GHOST, None, GHOST),
        ("Return to IT", None, None, None),
    ],
)
def test_store_recipient(reason, to_user_id, to_user, expected):
    assert handover_import.store_recipient(reason, to_user_id, to_user) == expected


@pytest.mark.parametrize(
    ("a", "b", "confusable"),
    [
        ("VPHN349", "VHPN351", True),   # transposed prefix — the live duplicate
        ("VPHN349", "VPHN340", True),   # one slipped digit
        ("TTS010", "VPHN318", False),   # intern code + staff code, one person
        ("VPHN287", "VPHN286", True),
        ("VPHN201", "VPHN254", False),  # two digits apart, two real people
    ],
)
def test_confusable_codes(a, b, confusable):
    from be.routers.imports import _confusable
    assert _confusable(a, b) is confusable


async def test_plan_reports_a_spec_disagreement(client, pool, seed, parsed_one_item):
    await pool.execute(
        "INSERT INTO devices (serial_number, cpu, user_id, status) VALUES ($1,$2,$3,$4)",
        "5CD03347TB", "Core i5", GHOST, "in_stock",
    )
    r = await client.post("/imports/handover/plan", json={"parsed": parsed_one_item})
    item = r.json()["items"][0]
    assert item["device_action"] == "update"
    conflict = next(i for i in item["issues"] if i["kind"] == "device_field_conflict")
    cpu = next(f for f in conflict["payload"]["fields"] if f["field"] == "cpu")
    assert (cpu["current"], cpu["proposed"]) == ("Core i5", "core i3")


async def test_plan_of_a_single_hand_out_asks_for_no_return_row(client, seed, parsed_one_item):
    plan = (await client.post(
        "/imports/handover/plan", json={"parsed": parsed_one_item}
    )).json()
    assert len(plan["items"]) == 1
    assert plan["items"][0]["flow"] == ISSUE
    assert not any(i["kind"] == "flow_ambiguous" for i in plan["items"][0]["issues"])


async def test_plan_of_a_mixed_two_row_record(client, pool, seed, monkeypatch):
    """Row 1 the machine she already has coming back, row 2 a new one going out."""
    await pool.execute(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        "VPHN349", "Bùi Thị Thanh", "QA/QC",
    )
    await pool.execute(
        "INSERT INTO devices (serial_number, user_id, status) VALUES ($1,$2,$3)",
        "5CD03347TB", "VPHN349", "active",
    )
    await pool.execute(
        "INSERT INTO handovers (handover_id, handover_date, device_id, from_user_id,"
        " to_user_id) VALUES ($1,$2,$3,$4,$5)",
        "h-old", date(2026, 1, 5), "5CD03347TB", GHOST, "VPHN349",
    )
    reading = json.loads(json.dumps(READING_ONE_ITEM))
    reading["items"].append({
        "no": 2, "item": "Dell laptop", "quantity": 1,
        "detail": "Dell Latitude core i5 ram 16gb SSD 512gb",
        "serial": "DL-NEW-001", "note": "máy mới",
        "device": {"type": "Laptop", "brand": "Dell", "cpu": "core i5",
                   "ram": "16gb", "storage": "SSD 512gb", "name": "Dell laptop"},
    })
    _fake_llm(monkeypatch, reading)
    parsed = (await client.post(
        "/imports/handover/read", json={"sheet_text": SHEET_TWO_ITEMS}
    )).json()["parsed"]

    plan = (await client.post(
        "/imports/handover/plan", json={"parsed": parsed}
    )).json()
    first, second = plan["items"]
    assert first["flow"] == RETURN
    assert (first["from_user_id"], first["to_user_id"]) == ("VPHN349", "VPHN228")
    assert second["flow"] == ISSUE
    assert (second["from_user_id"], second["to_user_id"]) == ("VPHN228", "VPHN349")


async def test_plan_of_the_three_party_record(client, pool, seed, monkeypatch):
    """`ban giao Dana intern acc.xlsx` end to end at plan level. Bên C reaches the
    plan, and the two rows point at two different pairs — neither of them A↔B."""
    await pool.execute(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        "VPHN271", "Nguyễn Trà My", "SALES 2",
    )
    await pool.execute(
        "INSERT INTO devices (serial_number, user_id, status) VALUES ($1,$2,$3)",
        "5CD33443JJ", "VPHN271", "active",
    )
    _fake_llm(monkeypatch, READING_THREE_PARTIES)
    parsed = (await client.post(
        "/imports/handover/read", json={"sheet_text": SHEET_THREE_PARTIES}
    )).json()["parsed"]
    assert len(parsed["parties"]) == 3

    plan = (await client.post("/imports/handover/plan", json={"parsed": parsed})).json()
    assert plan["it_index"] == 0
    assert plan["it_code"] == "VPHN228"
    assert [p["label"] for p in plan["parties"]] == ["Bên A", "Bên B", "Bên C"]

    hp, asus = plan["items"]
    assert (hp["from_user_id"], hp["to_user_id"]) == ("VPHN271", "TTS018")
    assert hp["device_owner_after"] == "TTS018"
    assert (asus["from_user_id"], asus["to_user_id"]) == ("VPHN228", "VPHN271")
    assert asus["device_owner_after"] == "VPHN271"
    assert asus["device_action"] == "create"
    assert [i["direction_source"] for i in plan["items"]] == ["note", "note"]

    # The minutes call VPHN271 "Naomi"; the ledger has "Nguyễn Trà My". That is a
    # real disagreement about a person, so it goes to a human rather than being
    # written over — unchanged behaviour, and worth pinning down.
    party_c = plan["parties"][2]
    conflict = next(i for i in party_c["issues"] if i["kind"] == "user_field_conflict")
    assert {f["field"] for f in conflict["payload"]["fields"]} == {"name", "team"}


# A record that moves one device twice: out to her, then back. The second row must
# see what the first one did.
SHEET_SAME_DEVICE_TWICE = SHEET_ONE_ITEM.replace(
    " 18 | Biên bản",
    " 17 | 2 | HP laptop | 1 | HP Laptop core i3 ram 8gb SSD 256gb | 5CD03347TB"
    " | bàn giao lại\n 18 | Biên bản",
)


async def test_plan_threads_one_device_through_two_movements(
    client, pool, seed, monkeypatch
):
    """Two rows, one serial. Planning both against the same starting row would
    make the second a repeat of the first; it has to see the first one's effect."""
    await pool.execute(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        "VPHN349", "Bùi Thị Thanh", "QA/QC",
    )
    await pool.execute(
        "INSERT INTO devices (serial_number, user_id, status) VALUES ($1,$2,$3)",
        "5CD03347TB", "VPHN349", "active",
    )
    reading = json.loads(json.dumps(READING_ONE_ITEM))
    second = json.loads(json.dumps(reading["items"][0]))
    second["no"], second["note"] = 2, "bàn giao lại"
    reading["items"].append(second)
    _fake_llm(monkeypatch, reading)
    parsed = (await client.post(
        "/imports/handover/read", json={"sheet_text": SHEET_SAME_DEVICE_TWICE}
    )).json()["parsed"]

    plan = (await client.post("/imports/handover/plan", json={"parsed": parsed})).json()
    first, again = plan["items"]
    # Two movements, told apart by row rather than by serial.
    assert [i["row"] for i in plan["items"]] == [1, 2]
    assert first["serial"] == again["serial"] == "5CD03347TB"

    assert first["flow"] == RETURN                      # she is holding it
    assert first["device_owner_after"] == GHOST
    assert again["flow"] == ISSUE                       # …so now it is in the store
    assert (again["from_user_id"], again["to_user_id"]) == ("VPHN228", "VPHN349")


# ------------------------------------------------------------------- /apply

def _apply_body(**over):
    body = {
        "source_file": "ban giao Thanh QC VPHN349.xlsx",
        "handover_date": "2026-07-21",
        "party_codes": ["VPHN228", "VPHN349"],
        "it_code": "VPHN228",
        "users": [{"code": "VPHN349", "action": "create",
                   "name": "Bùi Thị Thanh", "team": "QA/QC"}],
        "items": [{"serial": "5CD03347TB", "flow": ISSUE, "create_device": True,
                   "device_fields": {"brand": "HP", "cpu": "core i3", "ram": "8gb"}}],
        "issues": [],
    }
    body.update(over)
    return body


async def test_apply_hand_out_creates_everything_and_moves_the_owner(client, seed):
    r = await client.post("/imports/handover/apply", json=_apply_body())
    assert r.status_code == 200, r.text
    assert r.json()["users_created"] == 1
    assert r.json()["devices_created"] == 1
    assert r.json()["handovers_created"] == 1

    device = (await client.get("/devices/5CD03347TB")).json()
    assert device["user_id"] == "VPHN349"
    assert device["status"] == "active"
    assert device["cpu"] == "core i3"

    user = (await client.get("/users/VPHN349")).json()
    assert user["team"] == "QA/QC"
    assert user["status"] == "active"

    handover = (await client.get("/handovers")).json()[0]
    assert (handover["from_user_id"], handover["to_user_id"]) == ("VPHN228", "VPHN349")
    assert handover["handover_date"] == "2026-07-21"
    assert handover["reason"] == "Bàn giao máy mới"


async def test_apply_return_parks_the_device_on_the_ghost(client, seed):
    body = _apply_body(
        users=[],
        items=[{"serial": "SN-GIANG-1", "flow": RETURN}],
        party_codes=["VPHN228", "VPHN258"],
    )
    r = await client.post("/imports/handover/apply", json=body)
    assert r.status_code == 200, r.text

    device = (await client.get("/devices/SN-GIANG-1")).json()
    assert device["user_id"] == GHOST
    assert device["status"] == "in_stock"

    handover = (await client.get("/handovers")).json()[0]
    # The person who received it is recorded, even though the device parks on the ghost.
    assert (handover["from_user_id"], handover["to_user_id"]) == ("VPHN258", "VPHN228")
    assert handover["reason"] == "Trả về IT"


async def test_apply_writes_each_movement_between_its_own_pair(client, pool, seed):
    """The row-2 bug, at the level that actually corrupts data. Before this, apply
    recomputed both rows from one record-level pair and put the ASUS on the intern."""
    await pool.execute(
        "INSERT INTO users (employee_code, name, team) VALUES ($1,$2,$3)",
        "VPHN271", "Nguyễn Trà My", "SALES 2",
    )
    await pool.execute(
        "INSERT INTO devices (serial_number, user_id, status) VALUES ($1,$2,$3)",
        "5CD33443JJ", "VPHN271", "active",
    )
    body = _apply_body(
        source_file="ban giao Dana intern acc.xlsx",
        handover_date="2026-08-08",
        party_codes=["VPHN228", "TTS018", "VPHN271"],
        it_code="VPHN228",
        users=[{"code": "TTS018", "action": "create",
                "name": "Đặng Hà Anh", "team": "OPD"}],
        items=[
            {"row": 1, "serial": "5CD33443JJ", "flow": TRANSFER,
             "from_user_id": "VPHN271", "to_user_id": "TTS018"},
            {"row": 2, "serial": "W5N0CV08Z072214", "flow": ISSUE,
             "from_user_id": "VPHN228", "to_user_id": "VPHN271",
             "create_device": True, "device_fields": {"brand": "Asus"}},
        ],
    )
    r = await client.post("/imports/handover/apply", json=body)
    assert r.status_code == 200, r.text

    assert (await client.get("/devices/5CD33443JJ")).json()["user_id"] == "TTS018"
    # The one that used to land on TTS018.
    asus = (await client.get("/devices/W5N0CV08Z072214")).json()
    assert asus["user_id"] == "VPHN271"
    assert asus["status"] == "active"

    pairs = {
        (h["device_id"], h["from_user_id"], h["to_user_id"])
        for h in (await client.get("/handovers")).json()
    }
    assert pairs == {
        ("5CD33443JJ", "VPHN271", "TTS018"),
        ("W5N0CV08Z072214", "VPHN228", "VPHN271"),
    }


async def test_apply_moves_one_device_twice_in_row_order(client, seed):
    """Two movements of one serial in a single record: SN-GIANG-1 comes back from
    VPHN258 and goes straight out to VPHN216."""
    body = _apply_body(
        users=[],
        party_codes=["VPHN228", "VPHN258", "VPHN216"],
        it_code="VPHN228",
        items=[
            {"row": 1, "serial": "SN-GIANG-1", "flow": RETURN,
             "from_user_id": "VPHN258", "to_user_id": "VPHN228"},
            {"row": 2, "serial": "SN-GIANG-1", "flow": ISSUE,
             "from_user_id": "VPHN228", "to_user_id": "VPHN216"},
        ],
    )
    r = await client.post("/imports/handover/apply", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["handovers_created"] == 2

    device = (await client.get("/devices/SN-GIANG-1")).json()
    assert device["user_id"] == "VPHN216"      # the LAST movement wins
    assert device["status"] == "active"
    assert len((await client.get("/handovers")).json()) == 2


async def test_apply_parks_a_movement_landing_on_it_in_the_store(client, seed):
    """A pair whose receiver is the IT side still means the store, not the person
    who signed for it — derived from the movement, not from a reason string."""
    body = _apply_body(
        users=[],
        items=[{"row": 1, "serial": "SN-GIANG-1", "flow": RETURN,
                "from_user_id": "VPHN258", "to_user_id": "VPHN228"}],
    )
    assert (await client.post("/imports/handover/apply", json=body)).status_code == 200
    device = (await client.get("/devices/SN-GIANG-1")).json()
    assert device["user_id"] == GHOST
    assert device["status"] == "in_stock"
    # The person who received it is still recorded on the handover itself.
    handover = (await client.get("/handovers")).json()[0]
    assert (handover["from_user_id"], handover["to_user_id"]) == ("VPHN258", "VPHN228")


async def test_apply_refuses_an_unknown_device_without_permission(client, seed):
    body = _apply_body(items=[{"serial": "NOPE-1", "flow": ISSUE, "create_device": False}])
    r = await client.post("/imports/handover/apply", json=body)
    assert r.status_code == 409
    assert "NOPE-1" in r.json()["detail"]


async def test_apply_rejects_an_unknown_flow(client, seed):
    body = _apply_body(items=[{"serial": "SN-GIANG-1", "flow": "sideways"}])
    r = await client.post("/imports/handover/apply", json=body)
    assert r.status_code == 400


async def test_apply_skips_a_row_the_user_dropped(client, seed):
    body = _apply_body(users=[], items=[{"serial": "SN-GIANG-1", "flow": "skip"}])
    r = await client.post("/imports/handover/apply", json=body)
    assert r.json()["handovers_skipped"] == 1
    assert r.json()["handovers_created"] == 0
    assert (await client.get("/handovers")).json() == []


async def test_apply_rolls_back_everything_on_failure(client, seed):
    """A bad row must not leave the earlier rows of the same record behind."""
    body = _apply_body(items=[
        {"serial": "5CD03347TB", "flow": ISSUE, "create_device": True},
        {"serial": "ALSO-NEW", "flow": ISSUE, "create_device": False},  # 409s
    ])
    r = await client.post("/imports/handover/apply", json=body)
    assert r.status_code == 409
    assert (await client.get("/devices/5CD03347TB")).status_code == 404
    assert (await client.get("/users/VPHN349")).status_code == 404
    assert (await client.get("/handovers")).json() == []


async def test_apply_logs_unresolved_issues_and_the_badge_counts_them(client, seed):
    body = _apply_body(issues=[{
        "kind": "device_created_incomplete",
        "resource": "devices",
        "item_id": "5CD03347TB",
        "payload": {"missing": ["barcode", "buy_date", "os", "msoffice"]},
    }])
    r = await client.post("/imports/handover/apply", json=body)
    assert r.json()["issues_logged"] == 1

    assert (await client.get("/imports/issues/count")).json() == {"open": 1}
    issue = (await client.get("/imports/issues")).json()[0]
    assert issue["kind"] == "device_created_incomplete"
    assert issue["payload"]["missing"] == ["barcode", "buy_date", "os", "msoffice"]
    assert issue["source_file"] == "ban giao Thanh QC VPHN349.xlsx"


async def test_apply_refuses_an_unknown_issue_kind(client, seed):
    body = _apply_body(issues=[{"kind": "made_up", "item_id": "x", "payload": {}}])
    r = await client.post("/imports/handover/apply", json=body)
    assert r.status_code == 400
    assert "made_up" in r.json()["detail"]
    # And the whole record rolled back with it.
    assert (await client.get("/devices/5CD03347TB")).status_code == 404


async def test_reimporting_is_caught_as_a_duplicate_not_reversed(client, seed, monkeypatch):
    """Apply, then plan the same record again: the second pass must report the
    existing handover rather than reading the moved owner as a return."""
    await client.post("/imports/handover/apply", json=_apply_body())

    _fake_llm(monkeypatch, READING_ONE_ITEM)
    parsed = (await client.post(
        "/imports/handover/read", json={"sheet_text": SHEET_ONE_ITEM}
    )).json()["parsed"]
    item = (await client.post(
        "/imports/handover/plan", json={"parsed": parsed}
    )).json()["items"][0]

    assert item["flow"] == ISSUE                      # NOT flipped to return
    assert item["duplicate_of"] is not None
    assert any(i["kind"] == "handover_duplicate" for i in item["issues"])


# ------------------------------------------------------------------ issues API

async def test_resolving_an_issue_clears_it_from_the_badge(client, seed):
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "user_field_conflict", "resource": "users", "item_id": "VPHN228",
        "payload": {"fields": [{"field": "team", "current": "IT", "proposed": "Operation"}]},
    }]))
    issue = (await client.get("/imports/issues")).json()[0]

    r = await client.patch(
        f"/imports/issues/{issue['id']}",
        json={"status": "resolved", "resolution": {"team": "Operation"}},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "resolved"
    assert r.json()["resolution"] == {"team": "Operation"}
    assert r.json()["resolved_at"] is not None

    assert (await client.get("/imports/issues/count")).json() == {"open": 0}
    assert (await client.get("/imports/issues")).json() == []
    assert len((await client.get("/imports/issues?status=all")).json()) == 1


async def test_dismissing_keeps_the_row_in_the_log(client, seed):
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "flow_ambiguous", "resource": "handovers", "item_id": "SN-GIANG-1",
        "payload": {"reason": "không rõ"},
    }]))
    issue = (await client.get("/imports/issues")).json()[0]
    r = await client.patch(f"/imports/issues/{issue['id']}", json={"status": "dismissed"})
    assert r.json()["status"] == "dismissed"
    assert (await client.get("/imports/issues/count")).json() == {"open": 0}


async def test_unknown_issue_is_404(client, seed):
    r = await client.patch("/imports/issues/999999", json={"status": "resolved"})
    assert r.status_code == 404


async def test_bad_status_is_400(client, seed):
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "user_created", "resource": "users", "item_id": "VPHN349", "payload": {},
    }]))
    issue = (await client.get("/imports/issues")).json()[0]
    r = await client.patch(f"/imports/issues/{issue['id']}", json={"status": "banana"})
    assert r.status_code == 400


async def test_the_same_issue_is_not_logged_twice(client, seed):
    """Re-importing a record the team has not worked through yet is normal; the
    same disagreement listed twice reads as two jobs."""
    body = _apply_body(issues=[{
        "kind": "user_field_conflict", "resource": "users", "item_id": "VPHN228",
        "payload": {"fields": [{"field": "team", "current": "IT", "proposed": "Ops"}]},
    }])
    assert (await client.post("/imports/handover/apply", json=body)).json()[
        "issues_logged"
    ] == 1
    body["items"] = []  # the handover itself already exists now
    assert (await client.post("/imports/handover/apply", json=body)).json()[
        "issues_logged"
    ] == 0
    assert (await client.get("/imports/issues/count")).json() == {"open": 1}


# ---------------------------------------------------------------- issue recheck

async def test_recheck_closes_a_device_once_its_specs_are_filled_in(client, pool, seed):
    """The complaint that started this: fill the missing fields from the Devices
    screen and the notification asking for them is still sitting there."""
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "device_created_incomplete", "resource": "devices",
        "item_id": "SN-GIANG-1",
        "payload": {"missing": ["barcode", "buy_date", "os", "msoffice"]},
    }]))
    assert (await client.post("/imports/issues/recheck")).json() == {"closed": 0}

    await pool.execute(
        "UPDATE devices SET barcode=$1, buy_date=$2, os=$3, msoffice=$4 "
        "WHERE serial_number=$5",
        "BC-1", date(2025, 1, 2), "Windows 11", "Office 365", "SN-GIANG-1",
    )
    assert (await client.post("/imports/issues/recheck")).json() == {"closed": 1}
    assert (await client.get("/imports/issues/count")).json() == {"open": 0}


async def test_recheck_narrows_a_partly_completed_device(client, pool, seed):
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "device_created_incomplete", "resource": "devices",
        "item_id": "SN-GIANG-1",
        "payload": {"missing": ["barcode", "buy_date", "os", "msoffice"]},
    }]))
    await pool.execute(
        "UPDATE devices SET barcode=$1, os=$2 WHERE serial_number=$3",
        "BC-1", "Windows 11", "SN-GIANG-1",
    )
    assert (await client.post("/imports/issues/recheck")).json() == {"closed": 0}
    issue = (await client.get("/imports/issues")).json()[0]
    assert issue["payload"]["missing"] == ["buy_date", "msoffice"]


async def test_recheck_closes_a_field_conflict_the_ledger_has_answered(
    client, pool, seed
):
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "user_field_conflict", "resource": "users", "item_id": "VPHN228",
        "payload": {"fields": [
            {"field": "team", "current": "IT", "proposed": "Operation"},
        ]},
    }]))
    assert (await client.post("/imports/issues/recheck")).json() == {"closed": 0}

    await pool.execute(
        "UPDATE users SET team=$1 WHERE employee_code=$2", "Operation", "VPHN228"
    )
    assert (await client.post("/imports/issues/recheck")).json() == {"closed": 1}
    assert (await client.get("/imports/issues?status=all")).json()[0][
        "status"
    ] == "resolved"


async def test_recheck_dismisses_an_issue_whose_row_is_gone(client, pool, seed):
    """An issue pointing at an employee code with no record cannot be acted on —
    the Notifications screen used to offer a "fix" that PATCHed a 404."""
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "user_field_conflict", "resource": "users", "item_id": "VPHN999",
        "payload": {"fields": [{"field": "team", "current": None, "proposed": "QA"}]},
    }]))
    assert (await client.post("/imports/issues/recheck")).json() == {"closed": 1}
    row = (await client.get("/imports/issues?status=all")).json()[0]
    assert row["status"] == "dismissed"
    assert "không còn" in row["resolution"]["auto"]


async def test_recheck_leaves_a_handover_scoped_issue_for_a_human(client, seed):
    await client.post("/imports/handover/apply", json=_apply_body(issues=[{
        "kind": "flow_ambiguous", "resource": "handovers", "item_id": "SN-GIANG-1",
        "payload": {"reason": "không rõ"},
    }]))
    assert (await client.post("/imports/issues/recheck")).json() == {"closed": 0}
    assert (await client.get("/imports/issues/count")).json() == {"open": 1}


async def test_recheck_reads_the_referenced_rows_in_bulk(client, pool, seed, monkeypatch):
    """The row lookups must not scale with the size of the backlog.

    This used to re-read the referenced row inside the loop, so a full backlog
    cost one query per issue — up to 500 sequential round-trips in a request the
    Notifications screen makes before every list. Pinned as a count because the
    behaviour tests above cannot see the difference: both versions give the same
    answer, just one of them N times slower.
    """
    calls = {"device_get": 0, "user_get": 0, "device_get_many": 0, "user_get_many": 0}

    def counted(module, name, key):
        original = getattr(module, name)

        async def wrapper(*a, **kw):
            calls[key] += 1
            return await original(*a, **kw)

        monkeypatch.setattr(module, name, wrapper)

    counted(device_repo, "get", "device_get")
    counted(user_repo, "get", "user_get")
    counted(device_repo, "get_many", "device_get_many")
    counted(user_repo, "get_many", "user_get_many")

    # Twelve issues across both resources, none of which the ledger has answered.
    await client.post("/imports/handover/apply", json=_apply_body(issues=[
        {
            "kind": "device_created_incomplete", "resource": "devices",
            "item_id": "SN-GIANG-1",
            "payload": {"missing": ["barcode", "buy_date"], "n": n},
        }
        for n in range(6)
    ] + [
        {
            "kind": "user_field_conflict", "resource": "users", "item_id": "VPHN228",
            "payload": {"fields": [
                {"field": "team", "current": "IT", "proposed": f"Ops{n}"},
            ]},
        }
        for n in range(6)
    ]))
    for key in calls:
        calls[key] = 0

    r = await client.post("/imports/issues/recheck")
    assert r.status_code == 200, r.text

    assert calls["device_get_many"] == 1
    assert calls["user_get_many"] == 1
    # Zero per-issue reads, whatever the backlog size.
    assert calls["device_get"] == 0
    assert calls["user_get"] == 0
