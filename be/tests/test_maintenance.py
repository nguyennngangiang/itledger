"""Maintenance resource: FK to a device, money round-trip, trash lifecycle."""
from decimal import Decimal

NEW = {
    "maintenance_id": "MX-T1",
    "maintenance_date": "2026-07-11",
    "device_id": "SN-QUAN-1",
    "team": "Accountant",
    "part": "RAM",
    "reason": "Máy chạy chậm",
    "solution": "Thêm RAM",
    "result": "Nhanh hơn",
    "cost_vnd": 300000,
    "remarks": "Bảo hành còn hạn",
}


IMPORT_ROWS = [
    {"maintenance_id": "IMP-1", "maintenance_date": "2026-03-01",
     "device_id": "SN-QUAN-1", "part": "RAM", "reason": "Chậm"},
    {"maintenance_id": "IMP-2", "maintenance_date": "2026-03-02",
     "device_id": "SN-GIANG-1", "part": "Ổ cứng", "reason": "Kêu to"},
]


async def test_import_inserts_rows(client, seed):
    r = await client.post("/maintenance/import", json=IMPORT_ROWS)
    assert r.status_code == 200, r.text
    assert r.json() == {"inserted": 2, "skipped": 0, "total": 2}
    assert len((await client.get("/maintenance")).json()) == 2


async def test_import_is_idempotent_despite_fresh_ids(client, seed):
    """The dedup key is (device, date, part), NOT the id: maintenance_id is minted
    per row, so a second run of the same file carries new ids and would otherwise
    duplicate every repair."""
    await client.post("/maintenance/import", json=IMPORT_ROWS)
    again = [{**row, "maintenance_id": f"OTHER-{i}"}
             for i, row in enumerate(IMPORT_ROWS)]
    r = await client.post("/maintenance/import", json=again)
    assert r.json() == {"inserted": 0, "skipped": 2, "total": 2}
    assert len((await client.get("/maintenance")).json()) == 2


async def test_import_skips_an_unknown_serial_instead_of_failing(client, seed):
    rows = IMPORT_ROWS + [{"maintenance_id": "IMP-X", "device_id": "SN-NOPE",
                           "maintenance_date": "2026-03-03", "part": "Pin"}]
    r = await client.post("/maintenance/import", json=rows)
    assert r.status_code == 200, r.text
    assert r.json() == {"inserted": 2, "skipped": 1, "total": 3}


async def test_import_keeps_a_second_repair_on_a_different_part(client, seed):
    # Same device and date but another part is a real second repair, not a dupe.
    rows = [IMPORT_ROWS[0],
            {**IMPORT_ROWS[0], "maintenance_id": "IMP-3", "part": "Bàn phím"}]
    r = await client.post("/maintenance/import", json=rows)
    assert r.json()["inserted"] == 2


async def test_list_is_newest_first_not_by_id(client, seed):
    """maintenance_id is a UUID in the app, so ordering by it scrambled the repair
    story. Ids here are deliberately in the reverse order of the dates."""
    for mid, day in (("ZZ-old", "2026-01-05"), ("AA-new", "2026-09-09")):
        await client.post("/maintenance", json={
            "maintenance_id": mid, "maintenance_date": day,
            "device_id": "SN-QUAN-1", "part": "RAM",
        })
    dates = [m["maintenance_date"] for m in (await client.get("/maintenance")).json()]
    assert dates == ["2026-09-09", "2026-01-05"]


async def test_create_returns_201(client, seed):
    r = await client.post("/maintenance", json=NEW)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["maintenance_id"] == "MX-T1"
    assert body["maintenance_date"] == "2026-07-11"


async def test_cost_round_trips_without_precision_loss(client, seed):
    r = await client.post(
        "/maintenance", json={**NEW, "maintenance_id": "MX-T2", "cost_vnd": 1234567.89}
    )
    assert r.status_code == 201, r.text
    assert Decimal(str(r.json()["cost_vnd"])) == Decimal("1234567.89")


async def test_unknown_device_is_409_not_500(client, seed):
    r = await client.post(
        "/maintenance", json={**NEW, "maintenance_id": "MX-T3",
                              "device_id": "NO-SUCH-DEVICE"}
    )
    assert r.status_code == 409, r.text


async def test_duplicate_id_is_409(client, seed):
    assert (await client.post("/maintenance", json=NEW)).status_code == 201
    assert (await client.post("/maintenance", json=NEW)).status_code == 409


async def test_a_repair_may_have_no_device(client, seed):
    # device_id is nullable: the real workbook has 3 repairs whose device could
    # not be resolved, and they must still be recordable.
    r = await client.post(
        "/maintenance", json={"maintenance_id": "MX-ORPHAN", "device_id": None,
                              "part": "Battery"}
    )
    assert r.status_code == 201, r.text


async def test_missing_row_is_404(client):
    assert (await client.get("/maintenance/NOPE")).status_code == 404


async def test_patch_partial_update(client, seed):
    assert (await client.post("/maintenance", json=NEW)).status_code == 201
    r = await client.patch("/maintenance/MX-T1", json={"result": "Đã xong"})
    assert r.status_code == 200, r.text
    assert r.json()["result"] == "Đã xong"
    assert r.json()["part"] == "RAM"  # untouched


async def test_trash_lifecycle(client, seed):
    assert (await client.post("/maintenance", json=NEW)).status_code == 201

    async def ids(deleted: bool):
        r = await client.get(
            "/maintenance/page",
            params={"limit": 100, "deleted": str(deleted).lower()},
        )
        return [m["maintenance_id"] for m in r.json()["rows"]]

    assert (await client.delete("/maintenance/MX-T1")).status_code == 204
    assert "MX-T1" not in await ids(False)
    assert "MX-T1" in await ids(True)

    # Restore is a path route here, not a body one like /devices/restore —
    # this is the shape fe/src/api/maintenance.ts actually calls.
    assert (await client.post("/maintenance/MX-T1/restore")).status_code == 200
    assert "MX-T1" in await ids(False)

    assert (await client.delete(
        "/maintenance/MX-T1", params={"permanent": "true"}
    )).status_code == 204
    assert (await client.get("/maintenance/MX-T1")).status_code == 404


async def test_page_search_covers_vietnamese_text_unaccented(client, seed):
    assert (await client.post("/maintenance", json=NEW)).status_code == 201
    for q in ("Máy chạy chậm", "may chay cham", "RAM", "bao hanh"):
        r = await client.get("/maintenance/page", params={"q": q, "limit": 100})
        assert r.status_code == 200, r.text
        assert [m["maintenance_id"] for m in r.json()["rows"]] == ["MX-T1"], q
