"""Scan: what is saved, how lines group, and what is learned. Claude itself is
monkeypatched — these tests are about the decisions made in code around it
(be/scan.py says which ones, and why they are not left to the model)."""
import base64

from be import scan
from be.scan import ReadAnswer, ReadLine


def _line(kind="device", name="Asus VivoBook E1504FA-BQ340W", serials=(), qty=None, **kw):
    return ReadLine(
        kind=kind, model_name=f"Laptop {name}", short_name=name,
        type=kw.get("type", "LAPTOP"), brand=kw.get("brand", "Asus"), cpu="", ram="16GB",
        storage="512GB SSD", os="", serials=list(serials),
        quantity=len(serials) if qty is None else qty, warranty_months=24,
        unsure=kw.get("unsure", []),
    )


def _answer(*lines):
    return ReadAnswer(vendor="HACOM", doc_type="Phiếu xuất kho", doc_number="",
                      doc_date="2026-06-22", lines=list(lines))


def test_clean_serial_strips_the_label_but_not_a_serial_that_starts_with_sn():
    assert scan.clean_serial("SN: W2N0CX01B92106A") == "W2N0CX01B92106A"
    assert scan.clean_serial("S/N 5CD0 3347TB") == "5CD03347TB"
    assert scan.clean_serial("SN242550042406") == "SN242550042406"
    assert scan.clean_serial("SN-STORE-1") == "SN-STORE-1"


def test_same_model_on_separate_rows_becomes_one_group():
    # Hacom's warehouse slip: one row per laptop.
    out = scan.group(_answer(_line(serials=["W3N0CV14732913B"]), _line(serials=["SN: W3N0CV147309132"])))
    assert len(out["items"]) == 1
    assert out["items"][0]["serials"] == ["W3N0CV14732913B", "W3N0CV147309132"]
    assert out["items"][0]["brand"] == "ASUS"


def test_stamps_promotions_giveaways_and_parts_are_never_items():
    out = scan.group(_answer(
        _line(serials=["A1"]),
        _line("service_stamp", "Tem Dịch vụ (7.5x4.5cm)", ["20260302406"]),
        _line("promotion", "Giảm 15% Loa Sony", []),
        _line("giveaway", "Balo Laptop Acer (Khuyến mại)", ["20260284034"]),
        _line("pc_part", "CPU Intel Core i7 14700", ["M5265MB503892"]),
    ))
    assert [g["serials"] for g in out["items"]] == [["A1"]]
    assert {s["kind"] for s in out["skipped"]} == {"service_stamp", "promotion", "giveaway", "pc_part"}
    # Kept whole, so the screen can put one back.
    assert next(s for s in out["skipped"] if s["kind"] == "pc_part")["serials"] == ["M5265MB503892"]


def test_quantity_above_serial_count_is_reported_missing():
    out = scan.group(_answer(_line("device", "LG 27U411A-B", ["601TFDZ1U746"], qty=3, type="MONITOR")))
    assert out["items"][0]["missing"] == 2


def test_serial_printed_twice_is_flagged():
    out = scan.group(_answer(_line(serials=["X1"]), _line("device", "Other model", ["X1"])))
    assert out["duplicates"] == ["X1"]


def test_correction_notes_pair_a_misread_serial():
    original = {"items": [{"name": "Asus", "model_name": "Asus", "serials": ["W5N0CV08Z07521D", "W5N0CV08ZO7521O"]}]}
    final = [{"name": "Asus", "serials": ["W5N0CV08Z07521D", "W5N0CV08Z07521C"]}]
    assert scan.correction_notes(original, final) == [
        "serial đọc 'W5N0CV08ZO7521O' → đúng là 'W5N0CV08Z07521C'"
    ]


def test_accepted_reading_teaches_nothing():
    items = [{"name": "Asus", "type": "LAPTOP", "serials": ["A1"]}]
    assert scan.correction_notes({"items": items}, items) == []


async def test_read_groups_and_marks_serials_already_in_the_ledger(client, seed, monkeypatch):
    seen = {}

    async def fake_read(data, mime, *, mode, examples):
        seen.update(mime=mime, mode=mode, examples=examples)
        return _answer(_line(serials=["SN-STORE-1", "NEW-1"]))

    monkeypatch.setattr(scan, "read", fake_read)
    r = await client.post("/scan/read", json={
        "name": "x.pdf", "mime": "application/pdf", "data": base64.b64encode(b"%PDF").decode(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["existing"] == ["SN-STORE-1"]
    assert seen == {"mime": "application/pdf", "mode": "document", "examples": []}


async def test_label_read_keeps_a_serial_claude_filed_as_a_giveaway(client, monkeypatch):
    async def fake_read(data, mime, *, mode, examples):
        return _answer(_line("giveaway", "Rapoo M1", ["55123000M1A5616"], type="ACCESSORY"))

    monkeypatch.setattr(scan, "read", fake_read)
    r = await client.post("/scan/read", json={
        "mime": "image/jpeg", "mode": "label", "data": base64.b64encode(b"x").decode(),
    })
    assert [g["serials"] for g in r.json()["items"]] == [["55123000M1A5616"]]


async def test_read_without_the_runner_says_so(client, monkeypatch, tmp_path):
    monkeypatch.setattr(scan.settings, "claude_runner_socket", str(tmp_path / "missing.sock"))
    r = await client.post("/scan/read", json={"mime": "image/png", "data": base64.b64encode(b"x").decode()})
    assert r.status_code == 503
    assert "claude -p" in r.json()["detail"]


async def test_save_creates_in_stock_devices_and_learns_corrections(client, seed, pool):
    r = await client.post("/scan/save", json={
        "vendor": "HACOM", "doc_type": "Biên bản bàn giao", "buy_date": "2026-07-15",
        "groups": [{"name": "Asus VivoBook E1504FA", "type": "LAPTOP", "brand": "ASUS",
                    "serials": ["NEW-1", " SN: NEW-2 ", "SN-STORE-1"]}],
        "original": {"items": [{"name": "Asus VivoBook E1504FA", "model_name": "Asus",
                                "serials": ["NEW-1", "NEW-Z", "SN-STORE-1"]}]},
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["inserted"], body["skipped"], body["existing"]) == (2, 1, ["SN-STORE-1"])
    assert body["learned"] is True

    row = await pool.fetchrow("SELECT user_id, status, buy_date::text, name FROM devices WHERE serial_number='NEW-2'")
    assert dict(row) == {"user_id": "IT-STORE", "status": "in_stock", "buy_date": "2026-07-15",
                         "name": "Asus VivoBook E1504FA"}

    status = (await client.get("/scan/status")).json()
    assert status["learned"] == 1


def _minutes(kind, parties, items):
    return scan.MinutesAnswer(kind=kind, doc_type="Biên bản bàn giao", doc_number="", handover_date="2026-09-25",
                              place="Hà Nội", reason="", parties=parties, items=items)


def _party(label, role, name="", code="", company=""):
    return scan.MinutesParty(label=label, role=role, name=name, code=code, dept="", position="",
                             company=company, address="", phone="")


def _mitem(item, serials, kind="device", type="LAPTOP"):
    return scan.MinutesItem(no="1", item=item, detail="", serials=serials, quantity=len(serials) or 1, note="",
                            kind=kind, type=type, brand="Asus", cpu="", ram="", storage="", os="", unsure=[])


async def test_internal_minutes_become_a_plan_ready_record(client, seed, monkeypatch):
    async def fake(blocks, examples):
        assert len(blocks) == 2  # both camera frames reach Claude as one record
        return _minutes("internal",
                        [_party("A", "giver", "Trịnh Thế Hưng", "vphn228"), _party("B", "receiver", "Nguyễn Minh Quân", "VPHN216")],
                        [_mitem("Laptop Asus", ["SN: SN-STORE-1", "NEW-9"]), _mitem("Tem dịch vụ", ["T1"], kind="service_stamp")])

    monkeypatch.setattr(scan, "read_minutes", fake)
    frame = {"mime": "image/jpeg", "data": base64.b64encode(b"x").decode()}
    r = await client.post("/scan/minutes/read", json={"frames": [frame, frame]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "internal"
    assert body["known_codes"]["VPHN228"]["name"] == "Trịnh Thế Hưng"
    assert body["existing"] == ["SN-STORE-1"]
    parsed = body["parsed"]
    assert [p["code"] for p in parsed["parties"]] == ["VPHN228", "VPHN216"]
    # one item per serial, stamps dropped
    assert [i["serial"] for i in parsed["items"]] == ["SN-STORE-1", "NEW-9"]

    plan = await client.post("/imports/handover/plan", json={"parsed": parsed, "source_file": "scan"})
    assert plan.status_code == 200, plan.text


async def test_supplier_minutes_become_the_supplier_review_list(client, monkeypatch):
    async def fake(blocks, examples):
        return _minutes("supplier",
                        [_party("A", "buyer", company="CÔNG TY TNHH YIC ONE"), _party("B", "seller", company="HACOM")],
                        [_mitem("Laptop Asus VivoBook", ["A1", "A2"]), _mitem("Balo", ["B1"], kind="giveaway")])

    monkeypatch.setattr(scan, "read_minutes", fake)
    r = await client.post("/scan/minutes/read", json={"frames": [{"mime": "application/pdf", "data": base64.b64encode(b"%PDF").decode()}]})
    reading = r.json()["reading"]
    assert reading["vendor"] == "HACOM"
    assert [g["serials"] for g in reading["items"]] == [["A1", "A2"]]
    assert [s["kind"] for s in reading["skipped"]] == ["giveaway"]


async def test_diag_logs_a_killed_scan(client, caplog):
    with caplog.at_level("WARNING", logger="uvicorn.error"):
        r = await client.post("/scan/diag", json={"mode": "minutes", "ran_s": 25, "ua": "iPhone", "x": "y" * 5000})
    assert r.status_code == 204
    line = next(m for m in caplog.messages if "scan tab killed" in m)
    assert '"mode": "minutes"' in line and len(line) < 2100
