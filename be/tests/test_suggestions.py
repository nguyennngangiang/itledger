"""The autocomplete feeds: what the forms offer must come from real rows.

The hardcoded lists these replaced had drifted badly — the device form
suggested "16 GB" while every row in the fleet says "16GB".
"""
from be.repositories import device as device_repo
from be.repositories import maintenance as maint_repo


async def test_device_suggestions_cover_every_allowed_field(client, seed):
    r = await client.get("/devices/suggestions")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == set(device_repo.SUGGESTABLE_FIELDS)
    assert sorted(body["brand"]) == ["Asus", "Dell", "HP"]
    assert body["os"] == sorted(body["os"])  # ordered, so the picker is stable


async def test_suggestions_exclude_trashed_rows(client, seed):
    # A brand that only survives in the trash must not be suggested back.
    await client.request(
        "DELETE", "/devices", json={"serial_number": "SN-GIANG-1"}
    )
    assert "HP" not in (await client.get("/devices/suggestions")).json()["brand"]


async def test_suggestions_collapse_case_variants(client, seed):
    # Real data holds both "Asus" and "ASUS"; offering both would just keep the
    # split growing. Majority spelling wins — here "Asus", with two rows to one.
    await client.post(
        "/devices",
        json={"serial_number": "SN-X", "brand": "ASUS", "user_id": "IT-STORE"},
    )
    await client.post(
        "/devices",
        json={"serial_number": "SN-Y", "brand": "Asus", "user_id": "IT-STORE"},
    )
    brands = (await client.get("/devices/suggestions")).json()["brand"]
    assert "Asus" in brands
    assert "ASUS" not in brands


async def test_maintenance_suggestions_reflect_logged_repairs(client, seed):
    await client.post(
        "/maintenance",
        json={
            "maintenance_id": "M-1",
            "device_id": "SN-QUAN-1",
            "team": "IT",
            "part": "Battery",
            "result": "Replaced",
        },
    )
    body = (await client.get("/maintenance/suggestions")).json()
    assert set(body) == set(maint_repo.SUGGESTABLE_FIELDS)
    assert body["part"] == ["Battery"]
    assert body["result"] == ["Replaced"]


async def test_blank_values_are_not_suggested(client, seed):
    # An all-whitespace cell is not a suggestion worth making.
    await client.post(
        "/devices",
        json={"serial_number": "SN-Z", "brand": "   ", "user_id": "IT-STORE"},
    )
    assert "" not in (await client.get("/devices/suggestions")).json()["brand"]
