"""Single shared-admin session auth — one account, no user table.

Added after a Strix pentest found every API endpoint reachable and writable
with zero authentication (strix_runs/172-17-0-1-8081_bc07: unauthenticated
PATCH on /users and /devices, full unauthenticated data access). Applied in
be/main.py as a `dependencies=[Depends(require_auth)]` on every router except
be/routers/auth.py's login endpoint itself.

Sessions are stateless signed tokens (HMAC-SHA256 over an expiry timestamp),
not a server-side session store — a token survives an api container restart,
which an in-memory set of valid tokens would not, and needs no shared storage
if this ever runs more than one worker.

Sent as `Authorization: Bearer <token>`, not a cookie, on purpose: a bearer
header is never attached automatically by the browser the way a cookie is,
so a forged cross-site request has nothing to ride along on — this is what
closes the CSRF finding (VULN-0004) too, without a separate CSRF-token
mechanism.
"""
import hashlib
import hmac
import time

from fastapi import Header, HTTPException

from .config import settings

SESSION_HOURS = 24


def _secret() -> bytes:
    if not settings.secret_key:
        # Fail loud: signing with a blank key would make every token
        # forgeable by anyone who noticed it was blank.
        raise HTTPException(500, "SECRET_KEY chưa được cấu hình trên server.")
    return settings.secret_key.encode()


def _sign(payload: str) -> str:
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def create_token() -> str:
    expires_at = str(int(time.time()) + SESSION_HOURS * 3600)
    return f"{expires_at}.{_sign(expires_at)}"


def _verify(token: str) -> bool:
    try:
        expires_at, sig = token.rsplit(".", 1)
    except ValueError:
        return False
    if not hmac.compare_digest(sig, _sign(expires_at)):
        return False
    try:
        return time.time() < int(expires_at)
    except ValueError:
        return False


def check_credentials(username: str, password: str) -> bool:
    # Blank ADMIN_PASSWORD means "not configured", never "no password
    # required" — without this, an unset env var would let anyone in with an
    # empty password (compare_digest("", "") is true).
    if not settings.admin_password:
        return False
    return hmac.compare_digest(username, settings.admin_username) and hmac.compare_digest(
        password, settings.admin_password
    )


async def require_auth(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: raises 401 unless a valid bearer token is present."""
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token or not _verify(token):
        raise HTTPException(401, "Chưa đăng nhập hoặc phiên đã hết hạn.")
