"""Login and the require_auth dependency — added after a Strix pentest found
every endpoint reachable with no authentication at all (see be/auth.py).

`client`/`pool` bypass `auth.require_auth` (conftest.py) so the other ~300
tests stay about their own router, not the login layer — these tests pop that
override where they need the real 401/200 behaviour back.
"""
import time

import pytest
from httpx import ASGITransport, AsyncClient

from be import auth
from be.config import settings
from be.main import app


async def test_login_with_correct_credentials_returns_a_token(client):
    r = await client.post(
        "/auth/login",
        json={"username": settings.admin_username, "password": settings.admin_password},
    )
    assert r.status_code == 200, r.text
    assert r.json()["token"]


async def test_login_with_wrong_password_is_401(client):
    r = await client.post(
        "/auth/login",
        json={"username": settings.admin_username, "password": "not-it"},
    )
    assert r.status_code == 401


async def test_login_with_wrong_username_is_401(client):
    r = await client.post(
        "/auth/login", json={"username": "someone-else", "password": settings.admin_password}
    )
    assert r.status_code == 401


async def test_protected_endpoint_401s_with_no_token(pool):
    # The `pool` fixture bypasses auth by default (see conftest.py) — undo
    # that for this one test to see the real dependency run.
    app.dependency_overrides.pop(auth.require_auth, None)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/devices")
    assert r.status_code == 401


async def test_protected_endpoint_401s_with_a_garbage_token(pool):
    app.dependency_overrides.pop(auth.require_auth, None)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/devices", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401


async def test_protected_endpoint_401s_with_an_expired_token(pool):
    app.dependency_overrides.pop(auth.require_auth, None)
    # A validly-signed token whose expiry has already passed — signed with
    # auth._sign directly rather than mocking time.time().
    expired = str(int(time.time()) - 10)
    token = f"{expired}.{auth._sign(expired)}"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/devices", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


async def test_protected_endpoint_200s_with_a_valid_token(pool):
    app.dependency_overrides.pop(auth.require_auth, None)
    token = auth.create_token()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/devices", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


async def test_health_endpoints_need_no_token(pool):
    app.dependency_overrides.pop(auth.require_auth, None)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.get("/health")).status_code == 200
        assert (await c.get("/healthz")).status_code == 200


async def test_a_blank_admin_password_refuses_every_login(client, monkeypatch):
    # Empty-string compare_digest("", "") is True — check_credentials must
    # treat "not configured" as "nobody gets in", never as "no password
    # needed".
    monkeypatch.setattr(settings, "admin_password", "")
    r = await client.post("/auth/login", json={"username": settings.admin_username, "password": ""})
    assert r.status_code == 401
