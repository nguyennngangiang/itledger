"""GLPI export: the file contract, the skip rules, and the endpoint.

The row builders are pure, so most of this needs no database — which is the
point of keeping them pure. The three cases that *do* need one are the ones a
unit test cannot prove: that the trash never leaves the building, that `--since`
filters handovers and maintenance but never devices, and that the ordering the
importer depends on comes out of SQL rather than out of luck.
"""
from datetime import date
from decimal import Decimal

import pytest

from be import export_glpi as ex

HEADERS = (ex.DEVICE_HEADER, ex.HANDOVER_HEADER, ex.MAINTENANCE_HEADER)

# A Biên bản bàn giao layout is refused by the importer, so none of these words
# may ever appear in a file we write — including in a header.
MINUTES_WORDS = ("bien ban ban giao", "handover minutes", "party a", "noi dung ban giao")


def dev(serial="SN1", **over):
    row = dict(
        serial_number=serial, barcode=None, type="laptop", brand="HP", cpu=None,
        ram=None, storage=None, os=None, msoffice=None, buy_date=None, name=None,
        user_id=None, status=None,
    )
    row.update(over)
    return row


def ho(hid="H1", **over):
    row = dict(handover_id=hid, handover_date=date(2024, 2, 1), device_id="SN1",
               from_user_id="IT-STORE", to_user_id="YIC0123", reason=None)
    row.update(over)
    return row


def mx(mid="M1", **over):
    row = dict(maintenance_id=mid, maintenance_date=date(2024, 6, 10), device_id="SN1",
               team=None, part=None, reason=None, solution=None, result=None,
               cost_vnd=None, remarks=None)
    row.update(over)
    return row


# --- the file contract -----------------------------------------------------

def test_headers_are_exactly_the_spec():
    assert ex.DEVICE_HEADER == [
        "Serial Number", "Barcode", "Type", "Brand", "CPU", "RAM", "Storage",
        "OS", "MS Office", "Buy Date", "Device Name", "Owner", "Status"]
    assert ex.HANDOVER_HEADER == ["Serial", "Handover Date", "From", "To", "Reason"]
    assert ex.MAINTENANCE_HEADER == [
        "Serial", "Maintenance Date", "Team", "Part", "Reason", "Solution",
        "Result", "Cost", "Remarks"]


def test_csv_is_crlf_comma_and_starts_with_the_header():
    text = ex.to_csv(ex.HANDOVER_HEADER, [["SN1", "2024-02-01", "IT-STORE", "YIC0123", "x"]])
    assert text.startswith("Serial,Handover Date,From,To,Reason\r\n")
    assert text.endswith("\r\n")
    assert "\n" not in text.replace("\r\n", "")


def test_file_is_written_with_a_bom_and_vietnamese_survives(tmp_path):
    p = tmp_path / "m.csv"
    ex.write_csv(p, ex.MAINTENANCE_HEADER,
                 [["SN1", "2024-06-10", "IT", "Pin", "Pin phồng", "Thay pin", "OK", "1200000", ""]])
    raw = p.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    assert "Pin phồng" in raw.decode("utf-8-sig")


def test_no_header_looks_like_handover_minutes():
    for header in HEADERS:
        joined = " ".join(header).lower()
        for word in MINUTES_WORDS:
            assert word not in joined


# --- value shaping ---------------------------------------------------------

@pytest.mark.parametrize("value", [None, "", "   ", "\t\n "])
def test_blank_becomes_empty_never_a_placeholder(value):
    assert ex.clean(value) == ""


def test_newline_inside_a_value_is_flattened_and_reported():
    w = ex.Warnings()
    assert ex.clean("hai\ndòng", w, "x") == "hai dòng"
    assert w


def test_code_is_upper_cased_and_the_change_is_reported():
    w = ex.Warnings()
    assert ex.code(" yic0123 ", w, "x") == "YIC0123"
    assert w, "a lower-case code in the ledger is worth telling a human about"
    assert ex.code("YIC0123") == "YIC0123"


@pytest.mark.parametrize("given,want", [
    (Decimal("1200000.00"), "1200000"), (0, "0"), (None, ""), ("", ""),
])
def test_cost_is_a_plain_integer(given, want):
    assert ex.vnd(given) == want


def test_negative_cost_is_dropped_not_exported():
    w = ex.Warnings()
    assert ex.vnd(Decimal("-5"), w, "x") == ""
    assert w


def test_dates_are_iso():
    assert ex.iso_date(date(2023, 4, 15)) == "2023-04-15"
    assert ex.iso_date(None) == ""


# --- devices ---------------------------------------------------------------

def test_device_row_shape_and_it_store_owner():
    w = ex.Warnings()
    rows = ex.device_rows([dev(user_id="IT-STORE", status="in_stock")], w)
    assert rows == [["SN1", "", "laptop", "HP", "", "", "", "", "", "", "", "IT-STORE", "in_stock"]]


def test_stock_is_it_store_and_never_an_empty_owner():
    """The spec is explicit: empty means "not given", not "in the IT store"."""
    rows = ex.device_rows([dev(user_id="IT-STORE")], ex.Warnings())
    assert rows[0][11] == "IT-STORE"


def test_serial_is_trimmed_and_duplicates_are_dropped():
    w = ex.Warnings()
    rows = ex.device_rows([dev(" SN1 "), dev("SN1"), dev("SN2")], w)
    assert [r[0] for r in rows] == ["SN1", "SN2"]
    assert w


def test_device_without_a_serial_is_skipped():
    w = ex.Warnings()
    assert ex.device_rows([dev("   ")], w) == []
    assert w


def test_unknown_status_and_type_are_passed_through_but_reported():
    w = ex.Warnings()
    rows = ex.device_rows([dev(status="broken", type="hub")], w)
    assert rows[0][12] == "broken", "never silently reshape the ledger's own value"
    assert len(w.lines()) == 2


# --- handovers -------------------------------------------------------------

def test_handover_row_shape():
    rows = ex.handover_rows([ho(reason="New hire")], ex.Warnings())
    assert rows == [["SN1", "2024-02-01", "IT-STORE", "YIC0123", "New hire"]]


def test_undated_handover_is_skipped_because_dedup_needs_the_date():
    w = ex.Warnings()
    assert ex.handover_rows([ho(handover_date=None)], w) == []
    assert w


def test_handover_without_a_recipient_is_skipped():
    assert ex.handover_rows([ho(to_user_id=None)], ex.Warnings()) == []


def test_handover_from_equals_to_is_skipped():
    assert ex.handover_rows([ho(from_user_id="YIC0123", to_user_id="YIC0123")],
                            ex.Warnings()) == []


def test_duplicate_handover_key_is_dropped():
    w = ex.Warnings()
    rows = ex.handover_rows([ho("H1"), ho("H2")], w)
    assert len(rows) == 1, "same (serial, date, from, to) is one handover"
    assert w


def test_reason_is_capped_at_255():
    rows = ex.handover_rows([ho(reason="x" * 300)], ex.Warnings())
    assert len(rows[0][4]) == 255


# --- maintenance -----------------------------------------------------------

def test_maintenance_row_shape():
    rows = ex.maintenance_rows(
        [mx(team="IT", part="Battery", reason="Swollen", solution="Replaced",
            result="OK", cost_vnd=Decimal("1200000"))], ex.Warnings())
    assert rows == [["SN1", "2024-06-10", "IT", "Battery", "Swollen", "Replaced",
                     "OK", "1200000", ""]]


def test_duplicate_maintenance_key_is_dropped():
    w = ex.Warnings()
    rows = ex.maintenance_rows([mx("M1", part="RAM"), mx("M2", part="RAM")], w)
    assert len(rows) == 1
    assert w


# --- determinism -----------------------------------------------------------

def test_two_runs_over_the_same_data_are_byte_identical(tmp_path):
    records = [dev("SN2", user_id="yic0123"), dev("SN1", user_id="IT-STORE")]
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    for p in (a, b):
        ex.write_csv(p, ex.DEVICE_HEADER, ex.device_rows(records, ex.Warnings()))
    assert a.read_bytes() == b.read_bytes()


# --- against a real database ----------------------------------------------

async def _fixture(pool):
    await pool.execute(
        "INSERT INTO users (employee_code, name, status) VALUES "
        "('IT-STORE','IT Store','active'), ('YIC0123','Trần Văn A','active'), "
        "('YIC0456','Lê Thị B','retired')"
    )
    await pool.execute(
        "INSERT INTO devices (serial_number, type, user_id, status, deleted_at) VALUES "
        "('SN-LIVE','laptop','YIC0123','active',NULL), "
        "('SN-GONE','laptop','IT-STORE','in_stock',now())"
    )
    await pool.execute(
        "INSERT INTO handovers (handover_id, handover_date, device_id, from_user_id,"
        " to_user_id, deleted_at) VALUES "
        "('H2','2024-09-15','SN-LIVE','YIC0123','YIC0456',NULL), "
        "('H1','2024-02-01','SN-LIVE','IT-STORE','YIC0123',NULL), "
        "('H3','2025-03-03','SN-LIVE','YIC0456','IT-STORE',now())"
    )
    await pool.execute(
        "INSERT INTO maintenance (maintenance_id, maintenance_date, device_id, part,"
        " deleted_at) VALUES "
        "('M1','2024-06-10','SN-LIVE','Battery',NULL), "
        "('M2','2025-01-01','SN-LIVE','Screen',now())"
    )


async def test_deleted_rows_never_reach_the_export(pool):
    await _fixture(pool)
    data = await ex.fetch(pool, None)
    assert [r["serial_number"] for r in data["devices"]] == ["SN-LIVE"]
    assert [r["handover_id"] for r in data["handovers"]] == ["H1", "H2"]
    assert [r["maintenance_id"] for r in data["maintenance"]] == ["M1"]


async def test_handovers_come_back_sorted_by_date_then_id(pool):
    await _fixture(pool)
    data = await ex.fetch(pool, None)
    dates = [r["handover_date"] for r in data["handovers"]]
    assert dates == sorted(dates), "the importer carries the holder row to row"


async def test_since_filters_history_but_never_devices(pool):
    await _fixture(pool)
    data = await ex.fetch(pool, date(2024, 7, 1))
    assert [r["handover_id"] for r in data["handovers"]] == ["H2"]
    assert data["maintenance"] == []
    assert len(data["devices"]) == 1, "devices are always full — no updated_at to delta on"


async def test_retired_owner_is_exported_but_flagged(pool):
    await _fixture(pool)
    warn = ex.Warnings()
    built = ex.build(await ex.fetch(pool, None), None, warn)
    await ex.flag_risky_codes(pool, ex.codes_in(built), warn)
    assert any("may not be in GLPI" in line for line in warn.lines())
    assert "YIC0456" in " ".join(warn.lines())


# --- the endpoint ----------------------------------------------------------

async def test_endpoint_returns_a_bom_csv_attachment(client, pool):
    await _fixture(pool)
    r = await client.get("/export/glpi?kind=devices")
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"\xef\xbb\xbf")
    assert "itledger_devices_" in r.headers["content-disposition"]
    assert r.headers["x-export-rows"] == "1"


async def test_endpoint_rejects_an_unknown_kind(client, pool):
    assert (await client.get("/export/glpi?kind=nope")).status_code == 422


async def test_endpoint_rejects_a_bad_since(client, pool):
    assert (await client.get("/export/glpi?kind=handovers&since=01/02/2024")).status_code == 422
