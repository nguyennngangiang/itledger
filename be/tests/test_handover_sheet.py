"""Reading the company handover template without the model.

Plain synchronous unit tests — `be/handover_sheet.py` touches no database and no
network, which is the point of it existing separately.

The fixtures are the same real records `test_imports.py` uses, so what is under test
here is the shape that actually arrives from the browser.
"""
from be.handover_sheet import count_item_rows, read_sheet, split_device

from .test_imports import (
    SHEET_ONE_ITEM,
    SHEET_SAME_DEVICE_TWICE,
    SHEET_THREE_PARTIES,
    SHEET_TWO_ITEMS,
)


# ------------------------------------------------------------------ whole records

def test_reads_the_two_party_record():
    got = read_sheet(SHEET_ONE_ITEM)
    assert got["handover_date"] == "2026-07-21"
    assert got["place"] == "Tầng 05 , tòa nhà IDMC, Công ty TNHH YIC ONE"
    assert got["parties"] == [
        {"label": "A", "name": "Trịnh Thế Hưng", "code": "VPHN228",
         "dept": "Operation", "position": "IT"},
        {"label": "B", "name": "Bùi Thị Thanh", "code": "VPHN349",
         "dept": "QA", "position": "QC Staff"},
    ]
    item = got["items"][0]
    assert item["no"] == 1
    assert item["quantity"] == 1
    assert item["serial"] == "5CD03347TB"
    assert item["item"] == "HP laptop"
    assert item["detail"] == "HP Laptop core i3 ram 8gb SSD 256gb"
    assert item["note"] == "chuột có dây"


def test_reads_all_three_parties_and_both_rows():
    got = read_sheet(SHEET_THREE_PARTIES)
    assert [p["label"] for p in got["parties"]] == ["A", "B", "C"]
    assert [p["code"] for p in got["parties"]] == ["VPHN228", "TTS018", "VPHN271"]
    assert got["parties"][2]["name"] == "Naomi"
    # The Ghi chú cell carries the direction, which is how the team writes it — and
    # dropping it would silently cost the direction resolver its best evidence.
    assert [i["note"] for i in got["items"]] == ["271->TTS018", "228->271"]
    assert [i["serial"] for i in got["items"]] == ["5CD33443JJ", "W5N0CV08Z072214"]
    assert got["items"][1]["quantity"] == 2


def test_the_signature_block_is_not_two_more_parties():
    """The bottom of every record reads `Bên A | | | | Bên  B` over the signature
    lines. Read as party rows those would double the cast — so the parse is split at
    the item table's header and a party row must also carry a code column."""
    assert len(read_sheet(SHEET_ONE_ITEM)["parties"]) == 2


def test_one_device_moved_twice_is_two_rows():
    """A record can move the same serial twice. The rows are told apart by position,
    so both have to survive the read — merging them loses a movement."""
    got = read_sheet(SHEET_SAME_DEVICE_TWICE)
    assert [i["no"] for i in got["items"]] == [1, 2]
    assert [i["serial"] for i in got["items"]] == ["5CD03347TB", "5CD03347TB"]
    assert [i["note"] for i in got["items"]] == ["chuột có dây", "bàn giao lại"]


# ------------------------------------------------------- when it must decline

def test_declines_prose_with_no_table():
    """A scanned record extracts to prose. There is nothing to parse, and guessing
    would be worse than handing it to the model."""
    assert read_sheet("BIÊN BẢN BÀN GIAO ngày 21/07/2026, Bên A giao cho Bên B") is None


def test_declines_when_a_numbered_row_could_not_be_read():
    """The guard that makes the fast path safe. Row 2 is numbered but its serial
    cell is empty, so the parse is INCOMPLETE — and a parser that cannot see what it
    missed must not be trusted over the model. Eight of fifteen rows imported
    silently is the failure this prevents."""
    broken = SHEET_ONE_ITEM.replace(
        " 18 | Biên bản",
        " 17 | 2 | Dell laptop | 1 | Dell Latitude core i5 |  | máy mới\n 18 | Biên bản",
    )
    assert count_item_rows(broken) == 2  # the table still says two rows
    assert read_sheet(broken) is None


def test_declines_a_record_with_only_one_party():
    """Two parties is the floor: a record is at least two by definition, so one
    means the labels were not really found."""
    lonely = SHEET_ONE_ITEM.replace(
        " 12 | Bên B/ Party B: | Bùi Thị Thanh |  | Mã NV/ Code:  | VPHN349\n", ""
    )
    assert read_sheet(lonely) is None


def test_a_blank_value_does_not_swallow_the_next_label():
    """A value is "the next non-empty cell", and on a row whose name is blank that
    cell is the next LABEL. Reading the name as "Mã NV/ Code:" is worse than reading
    no name at all — the verifier would keep it, since it does occur in the file."""
    blank = SHEET_ONE_ITEM.replace(
        " 10 | Bên A/ Party A: | Trịnh Thế Hưng |  | Mã NV/ Code:  | VPHN228",
        " 10 | Bên A/ Party A: |  |  | Mã NV/ Code:  | VPHN228",
    )
    got = read_sheet(blank)
    assert got["parties"][0]["name"] is None
    assert got["parties"][0]["code"] == "VPHN228"


# ------------------------------------------------------------- the row counter

def test_counts_the_rows_before_anyone_reads_them():
    """The progress bar's denominator. Known up front and costing nothing, which is
    what lets the screen say "3 of 15" even when the model is doing the reading."""
    assert count_item_rows(SHEET_ONE_ITEM) == 1
    assert count_item_rows(SHEET_TWO_ITEMS) == 2
    assert count_item_rows(SHEET_THREE_PARTIES) == 2
    assert count_item_rows("no table here at all") == 0


# --------------------------------------------------------------- the spec split

def test_splits_the_detail_sentence():
    assert split_device("HP Laptop core i3 ram 8gb SSD 256gb", "HP laptop") == {
        "type": "Laptop", "brand": "HP", "cpu": "core i3",
        "ram": "8gb", "storage": "SSD 256gb", "name": "HP laptop",
    }


def test_ram_does_not_become_the_disk():
    """"ram 8gb SSD 256gb" contains "8gb SSD" one word before it contains "SSD
    256gb". Matched in the wrong order, every machine's storage is its RAM size."""
    got = split_device("HP Laptop core i3 ram 8gb SSD 256gb")
    assert got["ram"] == "8gb"
    assert got["storage"] == "SSD 256gb"


def test_reads_the_disk_written_the_other_way_round():
    got = split_device("Dell 256gb SSD ram 8gb core i5")
    assert got["ram"] == "8gb"
    assert got["storage"] == "256gb SSD"


def test_keeps_the_i7_ultra_that_marks_an_it_laptop():
    """`handover_import.is_it_own_machine` looks for "i7 ultra" in the cpu — clip it
    to "core i7" and IT's own three laptops get swept into the store."""
    got = split_device("HP Laptop core i7 ultra ram 32gb nvme 1tb")
    assert got["cpu"] == "core i7 ultra"
    assert got["storage"] == "nvme 1tb"


def test_values_are_returned_as_the_file_spells_them():
    """Never normalised. `verify_parsed` requires every value to occur in the source
    text, so a tidied "SSD" where the file says "ssd" is thrown out as invented."""
    got = split_device("Asus laptop ryzen 5 ram 16gb ssd 512gb")
    assert got["storage"] == "ssd 512gb"
    assert got["type"] == "laptop"
    assert got["brand"] == "Asus"


def test_a_detail_with_no_specs_yields_nothing_invented():
    got = split_device("Màn hình LG 24 inch", "Màn hình")
    assert got["cpu"] is None and got["ram"] is None and got["storage"] is None
    assert got["type"] == "Màn hình"
    assert got["brand"] == "LG"


def test_a_missing_detail_is_not_an_error():
    assert split_device(None, "HP laptop")["name"] == "HP laptop"
    assert split_device(None)["brand"] is None
