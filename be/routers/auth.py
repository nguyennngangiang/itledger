"""Login for the single shared admin account — see be/auth.py.

The only router mounted WITHOUT the `require_auth` dependency (see
be/main.py) — logging in is, by definition, the one thing that has to work
before a token exists.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import auth

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResult(BaseModel):
    token: str


@router.post("/login", response_model=LoginResult)
async def login(req: LoginRequest):
    if not auth.check_credentials(req.username, req.password):
        raise HTTPException(401, "Sai tên đăng nhập hoặc mật khẩu.")
    return {"token": auth.create_token()}
