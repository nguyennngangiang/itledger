"""Handovers resource: FK to device + both users, trash lifecycle.

The payload here is exactly what HandoverModal sends, including a client-generated
id — see fe/src/lib/id.ts for why that id is not crypto.randomUUID().
"""
from .conftest import GHOST

NEW = {
    "handover_id": "HO-T1",
    "handover_date": "2026-07-11",
    "device_id": "SN-QUAN-1",
    "from_user_id": "VPHN228",
    "to_user_id": "VPHN216",
    "reason": "Replacement",
}


async def test_create_returns_201(client, seed):
    r = await client.post("/handovers", json=NEW)
    assert r.status_code == 201, r.text
    assert r.json() == NEW


async def test_uuid_shaped_id_is_accepted(client, seed):
    # What the app actually generates now.
    uuid_id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
    r = await client.post("/handovers", json={**NEW, "handover_id": uuid_id})
    assert r.status_code == 201, r.text
    assert (await client.get(f"/handovers/{uuid_id}")).status_code == 200


async def test_unknown_user_is_409_not_500(client, seed):
    r = await client.post(
        "/handovers", json={**NEW, "handover_id": "HO-T2", "to_user_id": "NOBODY"}
    )
    assert r.status_code == 409, r.text


async def test_unknown_device_is_409(client, seed):
    r = await client.post(
        "/handovers", json={**NEW, "handover_id": "HO-T3", "device_id": "NO-SUCH"}
    )
    assert r.status_code == 409, r.text


async def test_duplicate_id_is_409(client, seed):
    assert (await client.post("/handovers", json=NEW)).status_code == 201
    assert (await client.post("/handovers", json=NEW)).status_code == 409


async def test_reason_is_optional(client, seed):
    r = await client.post(
        "/handovers", json={**NEW, "handover_id": "HO-T4", "reason": None}
    )
    assert r.status_code == 201, r.text
    assert r.json()["reason"] is None


async def test_missing_row_is_404(client):
    assert (await client.get("/handovers/NOPE")).status_code == 404


async def test_trash_lifecycle(client, seed):
    assert (await client.post("/handovers", json=NEW)).status_code == 201

    async def ids(deleted: bool):
        r = await client.get(
            "/handovers/page", params={"limit": 100, "deleted": str(deleted).lower()}
        )
        return [h["handover_id"] for h in r.json()["rows"]]

    assert (await client.delete("/handovers/HO-T1")).status_code == 204
    assert "HO-T1" not in await ids(False)
    assert "HO-T1" in await ids(True)

    # Restore is a path route here, not a body one like /devices/restore —
    # this is the shape fe/src/api/handovers.ts actually calls.
    assert (await client.post("/handovers/HO-T1/restore")).status_code == 200
    assert "HO-T1" in await ids(False)

    assert (await client.delete(
        "/handovers/HO-T1", params={"permanent": "true"}
    )).status_code == 204
    assert (await client.get("/handovers/HO-T1")).status_code == 404


async def test_list_is_newest_first_not_by_id(client, seed):
    """handover_id is a UUID in the app (fe/src/lib/id.ts), so ordering by it put a
    device's journey panel in essentially random order. Ids here are in the reverse
    order of the dates on purpose."""
    for hid, day in (("ZZ-oldest", "2026-01-05"), ("AA-newest", "2026-09-09")):
        r = await client.post("/handovers", json={
            **NEW, "handover_id": hid, "handover_date": day,
        })
        assert r.status_code == 201, r.text
    rows = (await client.get("/handovers")).json()
    assert [h["handover_date"] for h in rows][:2] == ["2026-09-09", "2026-01-05"]


async def test_suggestions_offer_reasons_already_in_use(client, seed):
    await client.post("/handovers", json={**NEW, "reason": "Trả về kho"})
    body = (await client.get("/handovers/suggestions")).json()
    assert body["reason"] == ["Trả về kho"]


async def test_suggestions_hide_trashed_rows(client, seed):
    await client.post("/handovers", json={**NEW, "reason": "Chỉ có trong thùng rác"})
    await client.delete("/handovers/HO-T1")
    assert (await client.get("/handovers/suggestions")).json()["reason"] == []


# --- same-day ordering and meaningless rows --------------------------------
#
# The live ledger had 5CD410FW9R standing in an IT staffer's name while the person
# who actually used it, Vũ Thị Hồng Vân, held it. Both handovers were dated the
# same day: she was issued the machine, and separately somebody returned one to
# IT. Tie-breaking on handover_id let the return win.

async def test_same_day_hand_out_beats_the_return(client, seed):
    """Collected then re-issued on one day: the hand-out is the later event."""
    # Deliberately give the RETURN the id that sorts last, which is what made the
    # real row wrong.
    await client.post("/handovers", json={
        "handover_id": "HO-AA-issue", "handover_date": "2026-07-11",
        "device_id": "SN-QUAN-1", "from_user_id": "VPHN228",
        "to_user_id": "VPHN216", "reason": "New Assignment",
    })
    await client.post("/handovers", json={
        "handover_id": "HO-ZZ-return", "handover_date": "2026-07-11",
        "device_id": "SN-QUAN-1", "from_user_id": "VPHN258",
        "to_user_id": GHOST, "reason": "Return to IT",
    })
    rows = (await client.get("/handovers", params={"device_id": "SN-QUAN-1"})).json()
    # Newest first, so the machine going OUT to a person leads.
    assert rows[0]["handover_id"] == "HO-AA-issue"
    assert rows[0]["to_user_id"] == "VPHN216"


async def test_same_day_return_recorded_against_the_it_person(client, seed):
    """The real shape of 5CD410FW9R, and the one an `= IT-STORE` test misses.

    A return names the IT staffer who signed for it — apply_flow writes
    `to_user_id = it_code` and sends only the DEVICE to the store — so the
    ordering has to read "went back to IT" off the recipient's team.
    Ids are chosen so a plain id tie-break would get it WRONG: the return sorts
    first by id, so only the team lookup can push it to the end.
    """
    await client.post("/handovers", json={
        "handover_id": "HO-999-issue", "handover_date": "2026-07-11",
        "device_id": "SN-QUAN-1", "from_user_id": "VPHN228",
        "to_user_id": "VPHN216", "reason": "New Assignment",
    })
    await client.post("/handovers", json={
        "handover_id": "HO-001-return", "handover_date": "2026-07-11",
        "device_id": "SN-QUAN-1", "from_user_id": "VPHN258",
        "to_user_id": "VPHN228", "reason": "Return to IT",   # VPHN228 is team IT
    })
    rows = (await client.get("/handovers", params={"device_id": "SN-QUAN-1"})).json()
    assert rows[0]["handover_id"] == "HO-999-issue"
    assert rows[-1]["handover_id"] == "HO-001-return"


async def test_oldest_first_puts_the_return_back_in_front(client, seed):
    """The tie-break follows the date's direction, or the table reads backwards."""
    for hid, to, reason in [
        ("HO-AA-issue", "VPHN216", "New Assignment"),
        ("HO-ZZ-return", GHOST, "Return to IT"),
    ]:
        await client.post("/handovers", json={
            "handover_id": hid, "handover_date": "2026-07-11",
            "device_id": "SN-QUAN-1", "from_user_id": "VPHN228",
            "to_user_id": to, "reason": reason,
        })
    body = (await client.get("/handovers/page", params={
        "order_by": "handover_date", "order": "asc", "limit": 10,
    })).json()
    same_day = [r["handover_id"] for r in body["rows"] if r["handover_date"] == "2026-07-11"]
    assert same_day == ["HO-ZZ-return", "HO-AA-issue"]


async def test_handover_to_nobody_is_refused(client, seed):
    r = await client.post("/handovers", json={**NEW, "to_user_id": None})
    assert r.status_code == 422
    assert "trống" in r.json()["detail"]


async def test_handover_to_yourself_is_refused(client, seed):
    r = await client.post("/handovers", json={
        **NEW, "from_user_id": "VPHN216", "to_user_id": "VPHN216",
    })
    assert r.status_code == 422
    assert "khác nhau" in r.json()["detail"]


async def test_patch_cannot_make_a_handover_meaningless(client, seed):
    """PATCH is partial, so the check has to look at the resulting row."""
    await client.post("/handovers", json=NEW)
    r = await client.patch("/handovers/HO-T1", json={"to_user_id": "VPHN228"})
    assert r.status_code == 422  # NEW.from_user_id is already VPHN228


async def test_page_total_is_the_unpaged_count(client, seed):
    for i in range(3):
        r = await client.post(
            "/handovers", json={**NEW, "handover_id": f"HO-P{i}"}
        )
        assert r.status_code == 201, r.text
    body = (await client.get("/handovers/page", params={"limit": 2})).json()
    assert len(body["rows"]) == 2
    assert body["total"] == 3
