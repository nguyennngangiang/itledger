"""Users resource + the unaccent search the Vietnamese-typing team depends on."""
import pytest

from .conftest import GHOST


async def test_health_and_db_roundtrip(client):
    assert (await client.get("/health")).json() == {"status": "ok"}
    body = (await client.get("/healthz")).json()
    assert body["db"] == "up", body


async def test_create_get_list(client):
    r = await client.post("/users", json={"name": "Lê Văn A", "team": "CAD",
                                          "employee_code": "T-1"})
    assert r.status_code == 201, r.text
    assert r.json() == {"employee_code": "T-1", "name": "Lê Văn A", "team": "CAD",
                        "status": "active"}

    assert (await client.get("/users/T-1")).json()["name"] == "Lê Văn A"
    assert [u["employee_code"] for u in (await client.get("/users")).json()] == ["T-1"]


async def test_duplicate_code_is_409(client):
    payload = {"employee_code": "T-1", "name": "A", "team": "X"}
    assert (await client.post("/users", json=payload)).status_code == 201
    r = await client.post("/users", json=payload)
    assert r.status_code == 409
    assert "T-1" in r.json()["detail"]


async def test_missing_user_is_404(client):
    assert (await client.get("/users/NOPE")).status_code == 404


async def test_patch_only_touches_sent_fields(client, seed):
    r = await client.patch("/users/VPHN216", json={"name": "Đổi Tên"})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "employee_code": "VPHN216", "name": "Đổi Tên", "team": "Accountant",
        "status": "active",
    }


async def test_new_people_start_active(client):
    r = await client.post("/users", json={
        "employee_code": "T-NEW", "name": "Bùi Thị Thanh", "team": "QA/QC",
    })
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "active"


async def test_retiring_someone_keeps_them_in_the_ledger(client, seed):
    """Retired is NOT the trash. Someone who has left still has to be findable:
    their handover history has to keep reading, and the machines they never
    handed back are only chaseable while they are still listed."""
    r = await client.patch("/users/VPHN216", json={"status": "retired"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "retired"

    # Still in the normal list, and still shown holding their device.
    codes = [u["employee_code"] for u in (await client.get("/users")).json()]
    assert "VPHN216" in codes
    held = (await client.get("/devices", params={"user_id": "VPHN216"})).json()
    assert [d["serial_number"] for d in held] == ["SN-QUAN-1"]


async def test_status_filter_splits_the_list(client, seed):
    await client.patch("/users/VPHN216", json={"status": "retired"})
    active = (await client.get("/users/page", params={
        "status": "active", "limit": 100,
    })).json()
    retired = (await client.get("/users/page", params={
        "status": "retired", "limit": 100,
    })).json()
    assert "VPHN216" not in [u["employee_code"] for u in active["rows"]]
    assert [u["employee_code"] for u in retired["rows"]] == ["VPHN216"]


async def test_no_team_filter_finds_people_missing_a_department(client, seed):
    """35 people in the live ledger have no department and no HR record to fill
    one from, so the screen needs a way to list exactly them."""
    await client.post("/users", json={"employee_code": "T-NOTEAM", "name": "Ai Đó"})
    body = (await client.get("/users/page", params={
        "no_team": "true", "limit": 100,
    })).json()
    assert [u["employee_code"] for u in body["rows"]] == ["T-NOTEAM"]


async def test_patch_can_clear_a_name(client, seed):
    # The name-fix tooling relies on this: sending null must write NULL, not skip.
    r = await client.patch("/users/VPHN216", json={"name": None})
    assert r.status_code == 200
    assert r.json()["name"] is None


@pytest.mark.parametrize(
    "query,expected",
    [
        ("VPHN216", ["VPHN216"]),          # by code
        ("Quân", ["VPHN216"]),             # by name, with diacritics
        ("quan", ["VPHN216"]),             # ...and without: unaccent() must fire
        ("NGUYEN", ["VPHN216", "VPHN258"]),  # case- and accent-insensitive
        ("Accounting", ["VPHN258"]),       # by team
        ("khong-co-ai", []),
    ],
)
async def test_search_matches_code_name_and_team(client, seed, query, expected):
    r = await client.get("/users/search", params={"q": query})
    assert r.status_code == 200, r.text
    assert sorted(u["employee_code"] for u in r.json()) == sorted(expected)


async def codes_in(client, **params) -> list[str]:
    r = await client.get("/users/page", params=params)
    assert r.status_code == 200, r.text
    return [u["employee_code"] for u in r.json()["rows"]]


async def test_delete_takes_the_code_in_the_body(client, seed):
    # The code goes in the BODY — there is no DELETE /users/{code} route.
    # VPHN228 owns no devices, so nothing blocks the delete.
    r = await client.request(
        "DELETE", "/users", json={"employee_code": "VPHN228"}
    )
    assert r.status_code == 204, r.text
    assert "VPHN228" not in [u["employee_code"] for u in (await client.get("/users")).json()]
    assert (await client.get(f"/users/{GHOST}")).status_code == 200


async def test_delete_by_path_is_not_a_route(client, seed):
    # Pins the contract that fe/src/api/users.ts deleteUser has to follow.
    assert (await client.delete("/users/VPHN228")).status_code == 405


async def test_soft_delete_lifecycle(client, seed):
    # delete -> trash -> restore -> purge, same shape as the other resources.
    assert "VPHN228" in await codes_in(client)

    r = await client.request("DELETE", "/users", json={"employee_code": "VPHN228"})
    assert r.status_code == 204, r.text
    assert "VPHN228" not in await codes_in(client)
    assert "VPHN228" in await codes_in(client, deleted=True)

    r = await client.post("/users/restore", json={"employee_code": "VPHN228"})
    assert r.status_code == 200, r.text
    assert "VPHN228" in await codes_in(client)
    assert "VPHN228" not in await codes_in(client, deleted=True)

    r = await client.request(
        "DELETE", "/users", json={"employee_code": "VPHN228"},
        params={"permanent": "true"},
    )
    assert r.status_code == 204, r.text
    assert (await client.get("/users/VPHN228")).status_code == 404


async def test_list_can_include_trashed_staff_for_history(client, seed):
    # Handover rows name whoever held the device at the time. Once that person
    # is trashed the screens' lookup map would drop them and the row would show
    # a bare code, so display maps ask for them explicitly.
    await client.request("DELETE", "/users", json={"employee_code": "VPHN228"})

    active = [u["employee_code"] for u in (await client.get("/users")).json()]
    assert "VPHN228" not in active

    everyone = (await client.get("/users", params={"include_deleted": "true"})).json()
    assert "VPHN228" in [u["employee_code"] for u in everyone]
    assert len(everyone) == len(active) + 1


async def test_delete_is_refused_while_the_person_still_owns_devices(client, seed):
    # VPHN216 owns SN-QUAN-1. Deleting them would leave the device pointing at
    # someone who is no longer in the list, so the API refuses and says how many.
    r = await client.request("DELETE", "/users", json={"employee_code": "VPHN216"})
    assert r.status_code == 409, r.text
    assert "1 device" in r.json()["detail"]
    assert "VPHN216" in await codes_in(client)


async def test_ghost_is_not_listed_as_an_employee(client, seed):
    # The Employees screen is a list of people; IT-STORE is the account that
    # ownerless devices park on. Excluded server-side so `total` stays honest.
    assert GHOST not in await codes_in(client)
    assert GHOST not in await codes_in(client, q="IT")
    r = await client.get("/users/page", params={"limit": 100})
    assert r.json()["total"] == len(seed["users"]) - 1

    # ...but the owner pickers and the display name maps still need it.
    assert GHOST in [u["employee_code"] for u in (await client.get("/users")).json()]


async def test_ghost_account_cannot_be_edited(client, seed):
    r = await client.patch(f"/users/{GHOST}", json={"name": "Something Else"})
    assert r.status_code == 409, r.text
    assert (await client.get(f"/users/{GHOST}")).json()["name"] == "IT Store"


async def test_ghost_account_cannot_be_deleted(client, seed):
    for params in ({}, {"permanent": "true"}):
        r = await client.request(
            "DELETE", "/users", json={"employee_code": GHOST}, params=params
        )
        assert r.status_code == 409, r.text
        assert GHOST in r.json()["detail"]
    assert (await client.get(f"/users/{GHOST}")).status_code == 200


async def test_batch_delete_takes_bare_codes(client, seed):
    # Same body shape as every other resource: a list of ids, not objects.
    r = await client.request("DELETE", "/users/batch", json=["VPHN228", "NOPE"])
    assert r.status_code == 204, r.text          # unknown codes are ignored
    assert "VPHN228" in await codes_in(client, deleted=True)


async def test_batch_delete_refuses_a_protected_code(client, seed):
    r = await client.request("DELETE", "/users/batch", json=["VPHN228", GHOST])
    assert r.status_code == 409, r.text
    # ...and the whole batch is rejected rather than half-applied.
    assert "VPHN228" in await codes_in(client)


async def test_page_paginates_and_ignores_an_unknown_sort_column(client, seed):
    # The ghost is never listed here, so the expected set is the seed minus it.
    staff = sorted(u[0] for u in seed["users"] if u[0] != GHOST)

    r = await client.get("/users/page", params={"limit": 2, "offset": 0})
    body = r.json()
    assert body["total"] == len(staff)
    assert len(body["rows"]) == 2

    # order_by is interpolated into SQL, so anything off the allow-list must
    # fall back to the default rather than reach the database.
    r = await client.get("/users/page", params={"order_by": "team; DROP TABLE users"})
    assert r.status_code == 200, r.text
    assert [u["employee_code"] for u in r.json()["rows"]] == staff


async def test_page_search_is_accent_insensitive(client, seed):
    assert await codes_in(client, q="quan") == ["VPHN216"]


async def test_teams_lists_what_is_actually_in_use(client, seed):
    r = await client.get("/users/teams")
    assert r.status_code == 200, r.text
    assert r.json() == ["Accountant", "Accounting", "IT"]


async def test_teams_collapses_case_variants(client, seed):
    # Two spellings of one team must not both show up in the picker; the more
    # common one wins (here: two "IT" rows against one "it").
    await client.post("/users", json={"employee_code": "T-9", "team": "it"})
    assert "it" not in (await client.get("/users/teams")).json()
    assert "IT" in (await client.get("/users/teams")).json()


class TestCreateBatch:
    """POST /users/batch was not transactional, and had no test.

    The frontend declares createUserBatch (fe/src/api/users.ts) but never calls
    it, so nothing exercised the endpoint and a half-applied batch went unnoticed.
    """

    async def test_a_duplicate_mid_batch_leaves_nothing_behind(self, client, seed):
        before = (await client.get("/users/page", params={"limit": 100})).json()["total"]
        # VPHN216 is seeded, so row 3 collides. Rows 1-2 used to be committed.
        r = await client.post("/users/batch", json=[
            {"employee_code": "T-1", "name": "One"},
            {"employee_code": "T-2", "name": "Two"},
            {"employee_code": "VPHN216", "name": "Clash"},
        ])
        assert r.status_code == 409, r.text
        assert "VPHN216" in r.json()["detail"]

        after = await client.get("/users/page", params={"limit": 100})
        codes = [u["employee_code"] for u in after.json()["rows"]]
        assert "T-1" not in codes
        assert "T-2" not in codes
        assert after.json()["total"] == before

    async def test_a_clean_batch_still_works(self, client, seed):
        before = (await client.get("/users/page", params={"limit": 100})).json()["total"]
        r = await client.post("/users/batch", json=[
            {"employee_code": "T-3", "name": "Three"},
            {"employee_code": "T-4", "name": "Four"},
        ])
        assert r.status_code == 201, r.text
        assert len(r.json()) == 2
        after = (await client.get("/users/page", params={"limit": 100})).json()["total"]
        assert after == before + 2
