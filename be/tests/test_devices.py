"""Devices resource: create, the soft-delete/trash lifecycle, batch, import, paging."""
import pytest

from .conftest import GHOST

NEW = {
    "serial_number": "SN-NEW-1",
    "name": "Dell Latitude 5420",
    "brand": "Dell",
    "type": "LAPTOP",
    "ram": "16 GB",
    "buy_date": "2026-01-15",
    "user_id": GHOST,
    "status": "in_stock",
}


async def test_create_returns_201_and_the_row(client, seed):
    r = await client.post("/devices", json=NEW)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["serial_number"] == "SN-NEW-1"
    assert body["buy_date"] == "2026-01-15"
    assert body["user_id"] == GHOST


async def test_create_with_only_a_serial(client, seed):
    # Everything but serial_number is optional — this is the minimum the Create
    # Device modal can send.
    r = await client.post("/devices", json={"serial_number": "SN-BARE"})
    assert r.status_code == 201, r.text
    assert r.json()["user_id"] is None


class TestItHeldStatusesOwnTheGhost:
    """maintaining / on_del mean IT is holding the machine, so no person owns it.

    Enforced in the repository, not just the form: an import or a direct API
    call must not be able to leave a device under repair on someone's name.
    """

    async def test_create_moves_it_to_the_store(self, client, seed):
        r = await client.post("/devices", json={
            **NEW, "serial_number": "SN-FIX", "user_id": "VPHN216",
            "status": "maintaining",
        })
        assert r.status_code == 201, r.text
        assert r.json()["user_id"] == GHOST
        assert r.json()["status"] == "maintaining"

    async def test_patching_only_the_status_still_moves_the_owner(self, client, seed):
        # SN-QUAN-1 belongs to VPHN216 and is active. Sending nothing but the
        # status has to take the owner with it.
        r = await client.patch("/devices/SN-QUAN-1", json={"status": "on_del"})
        assert r.status_code == 200, r.text
        assert r.json()["user_id"] == GHOST

    async def test_patching_only_the_owner_of_a_held_device_is_refused_silently(
        self, client, seed
    ):
        await client.patch("/devices/SN-QUAN-1", json={"status": "maintaining"})
        # Trying to hand a machine under repair to a person leaves it at the
        # store; the caller has to clear the status first.
        r = await client.patch("/devices/SN-QUAN-1", json={"user_id": "VPHN258"})
        assert r.status_code == 200, r.text
        assert r.json()["user_id"] == GHOST

    async def test_clearing_the_status_frees_the_device_again(self, client, seed):
        await client.patch("/devices/SN-QUAN-1", json={"status": "maintaining"})
        r = await client.patch(
            "/devices/SN-QUAN-1", json={"status": "active", "user_id": "VPHN258"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["user_id"] == "VPHN258"
        assert r.json()["status"] == "active"

    async def test_the_active_in_stock_pair_is_left_alone(self, client, seed):
        # That half is a UI default, deliberately still editable by hand.
        r = await client.post("/devices", json={
            **NEW, "serial_number": "SN-ODD", "user_id": "VPHN216",
            "status": "in_stock",
        })
        assert r.status_code == 201, r.text
        assert r.json()["user_id"] == "VPHN216"
        assert r.json()["status"] == "in_stock"


async def test_duplicate_serial_is_409(client, seed):
    assert (await client.post("/devices", json=NEW)).status_code == 201
    r = await client.post("/devices", json=NEW)
    assert r.status_code == 409
    assert "SN-NEW-1" in r.json()["detail"]


async def test_unknown_owner_is_409_not_500(client, seed):
    r = await client.post(
        "/devices", json={"serial_number": "SN-X", "user_id": "NO-SUCH-USER"}
    )
    assert r.status_code == 409
    assert "NO-SUCH-USER" in r.json()["detail"]


async def test_missing_device_is_404(client):
    assert (await client.get("/devices/NOPE")).status_code == 404


async def test_patch_partial_update(client, seed):
    r = await client.patch("/devices/SN-QUAN-1", json={"ram": "32 GB"})
    assert r.status_code == 200, r.text
    assert r.json()["ram"] == "32 GB"
    assert r.json()["name"] == "Asus Ryzen 5 16GB"  # untouched


async def test_trash_lifecycle(client, seed):
    async def active_serials():
        r = await client.get("/devices/page", params={"limit": 100})
        return [d["serial_number"] for d in r.json()["rows"]]

    async def trashed_serials():
        r = await client.get(
            "/devices/page", params={"limit": 100, "deleted": "true"}
        )
        return [d["serial_number"] for d in r.json()["rows"]]

    # soft delete
    r = await client.request(
        "DELETE", "/devices", json={"serial_number": "SN-GIANG-1"}
    )
    assert r.status_code == 204, r.text
    assert "SN-GIANG-1" not in await active_serials()
    assert "SN-GIANG-1" in await trashed_serials()
    # the row itself still exists
    assert (await client.get("/devices/SN-GIANG-1")).status_code == 200

    # restore
    r = await client.post("/devices/restore", json={"serial_number": "SN-GIANG-1"})
    assert r.status_code == 200, r.text
    assert "SN-GIANG-1" in await active_serials()

    # purge
    r = await client.request(
        "DELETE", "/devices", json={"serial_number": "SN-GIANG-1"},
        params={"permanent": "true"},
    )
    assert r.status_code == 204
    assert (await client.get("/devices/SN-GIANG-1")).status_code == 404


async def test_batch_delete_ignores_unknown_serials(client, seed):
    r = await client.request(
        "DELETE", "/devices/batch", json=["SN-QUAN-1", "DOES-NOT-EXIST"]
    )
    assert r.status_code == 204, r.text
    page = await client.get("/devices/page", params={"limit": 100})
    assert "SN-QUAN-1" not in [d["serial_number"] for d in page.json()["rows"]]


async def test_batch_route_is_not_read_as_a_serial(client, seed):
    # /batch is declared before /{serial_number}; if that order ever flips this
    # turns into a 404-or-worse.
    r = await client.request("DELETE", "/devices/batch", json=[])
    assert r.status_code == 204


async def test_import_is_idempotent(client, seed):
    rows = [NEW, {"serial_number": "SN-QUAN-1", "name": "would-overwrite"}]

    first = await client.post("/devices/import", json=rows)
    assert first.status_code == 200, first.text
    assert first.json() == {"inserted": 1, "skipped": 1, "total": 2}

    second = await client.post("/devices/import", json=rows)
    assert second.json() == {"inserted": 0, "skipped": 2, "total": 2}
    # the existing row was skipped, not rewritten
    assert (await client.get("/devices/SN-QUAN-1")).json()["name"] == "Asus Ryzen 5 16GB"


async def test_page_total_is_the_unpaged_count(client, seed):
    r = await client.get("/devices/page", params={"limit": 1})
    body = r.json()
    assert len(body["rows"]) == 1
    assert body["total"] == 3


@pytest.mark.parametrize("order_by", ["serial_number", "brand", "buy_date"])
async def test_page_sorts_by_allowed_columns(client, seed, order_by):
    r = await client.get(
        "/devices/page", params={"order_by": order_by, "order": "desc", "limit": 100}
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["rows"]) == 3


@pytest.mark.parametrize(
    "order_by",
    ["deleted_at", "; DROP TABLE devices; --", "1", "(SELECT 1)"],
)
async def test_page_rejects_columns_outside_the_allowlist(client, seed, order_by):
    # Falls back to serial_number rather than interpolating whatever arrived.
    r = await client.get("/devices/page", params={"order_by": order_by, "limit": 100})
    assert r.status_code == 200, r.text
    assert [d["serial_number"] for d in r.json()["rows"]] == [
        "SN-GIANG-1", "SN-QUAN-1", "SN-STORE-1",
    ]
    assert (await client.get("/devices/page")).json()["total"] == 3  # table intact


async def test_filter_rejects_columns_outside_the_allowlist(client, seed):
    ok = await client.get("/devices/filter", params={"field": "brand", "value": "Asus"})
    assert ok.status_code == 200
    assert [d["serial_number"] for d in ok.json()] == ["SN-QUAN-1"]

    # A rejected column is a client error, not a crash.
    bad = await client.get(
        "/devices/filter", params={"field": "deleted_at", "value": "x"}
    )
    assert bad.status_code == 400, bad.text
    assert "deleted_at" in bad.json()["detail"]
    assert (await client.get("/devices/page")).json()["total"] == 3  # table intact


class TestPurgingADeviceWithHistory:
    """Handovers and maintenance FK to devices and nothing cascades.

    Most of the real fleet has history, so this is the common path, not an edge
    case. It used to reach the client as an unhandled 500 because the bare
    DELETE in the repo caught nothing.
    """

    async def test_single_purge_is_refused_with_409(self, client, seed, pool):
        await pool.execute(
            "INSERT INTO handovers (handover_id, device_id, to_user_id) "
            "VALUES ('HO-1', 'SN-QUAN-1', 'VPHN258')"
        )
        r = await client.request(
            "DELETE", "/devices", json={"serial_number": "SN-QUAN-1"},
            params={"permanent": "true"},
        )
        assert r.status_code == 409, r.text
        assert "SN-QUAN-1" in r.json()["detail"]
        # refused, not half-applied
        assert (await client.get("/devices/SN-QUAN-1")).status_code == 200

    async def test_maintenance_history_blocks_it_too(self, client, seed, pool):
        await pool.execute(
            "INSERT INTO maintenance (maintenance_id, device_id, part) "
            "VALUES ('MT-1', 'SN-QUAN-1', 'Screen')"
        )
        r = await client.request(
            "DELETE", "/devices", json={"serial_number": "SN-QUAN-1"},
            params={"permanent": "true"},
        )
        assert r.status_code == 409, r.text

    async def test_batch_purge_refuses_the_whole_batch(self, client, seed, pool):
        await pool.execute(
            "INSERT INTO handovers (handover_id, device_id, to_user_id) "
            "VALUES ('HO-1', 'SN-QUAN-1', 'VPHN258')"
        )
        r = await client.request(
            "DELETE", "/devices/batch", json=["SN-QUAN-1", "SN-GIANG-1"],
            params={"permanent": "true"},
        )
        assert r.status_code == 409, r.text
        # One statement, so the clean device survives with the blocked one.
        assert (await client.get("/devices/page")).json()["total"] == 3

    async def test_a_device_without_history_still_purges(self, client, seed):
        r = await client.request(
            "DELETE", "/devices", json={"serial_number": "SN-GIANG-1"},
            params={"permanent": "true"},
        )
        assert r.status_code == 204, r.text
        assert (await client.get("/devices/SN-GIANG-1")).status_code == 404


class TestTheGhostIsBootstrapped:
    """owner_for_status() writes IT-STORE, so the row has to exist.

    The `seed` fixture supplies it, so these two drive an unseeded pool — the
    shape a fresh volume has before anyone runs be.seed.
    """

    async def test_ensure_ghost_lets_a_maintaining_device_be_created(self, client, pool):
        from be.repositories import user as user_repo

        await user_repo.ensure_ghost(pool)
        r = await client.post(
            "/devices", json={"serial_number": "SN-FRESH", "status": "maintaining"}
        )
        assert r.status_code == 201, r.text
        assert r.json()["user_id"] == GHOST

    async def test_ensure_ghost_is_idempotent(self, client, pool):
        from be.repositories import user as user_repo

        await user_repo.ensure_ghost(pool)
        await user_repo.ensure_ghost(pool)
        assert await pool.fetchval("SELECT count(*) FROM users") == 1

    async def test_without_the_ghost_the_error_names_the_code_it_tried(
        self, client, pool
    ):
        # The caller sent no user_id at all; saying "Unknown user_id: None" would
        # describe a value they never supplied instead of the ghost we substituted.
        r = await client.post(
            "/devices", json={"serial_number": "SN-FRESH", "status": "maintaining"}
        )
        assert r.status_code == 409, r.text
        assert GHOST in r.json()["detail"]
