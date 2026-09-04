from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from . import db, migrations
from .config import settings
from .repositories.errors import (
    DuplicateError,
    ForeignKeyError,
    InUseError,
    ProtectedError,
)
from .routers import devices, feedback, handovers, imports, maintenance, users

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    # Schema changes are applied here, idempotently, because schema.sql only runs
    # on a fresh volume — the deployed database holds real data and must never be
    # recreated to pick up a column. Everything in migrations.py is also mirrored
    # in schema.sql so a fresh machine gets the same shape.
    await migrations.run(db.get_pool())
    yield
    await db.disconnect()

app = FastAPI(title="ITLedger API", version="0.1.0", lifespan=lifespan)

# React dev server (Vite) runs on a different origin — allow it through.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def _conflict(request: Request, exc: Exception) -> JSONResponse:
    """Every domain refusal is a 409 carrying the repository's own message.

    DuplicateError  a unique constraint (serial, barcode, employee code)
    ForeignKeyError a referenced row is missing, or still references this one
    InUseError      refused up front (an employee who still holds devices)
    ProtectedError  a structural row (the IT-STORE ghost)

    Registered centrally so a router that forgets to catch one returns 409
    rather than 500 — which is how permanently deleting a device with history
    used to crash. Deliberately NOT extended to ValueError: Pydantic and half
    the standard library raise that, and blanket-mapping it to 4xx would turn
    real bugs into silent client errors. Those stay caught locally.
    """
    return JSONResponse(status_code=409, content={"detail": str(exc)})


for _domain_error in (DuplicateError, ForeignKeyError, InUseError, ProtectedError):
    app.add_exception_handler(_domain_error, _conflict)

app.include_router(devices.router)
app.include_router(handovers.router)
app.include_router(maintenance.router)
app.include_router(users.router)
app.include_router(feedback.router)
app.include_router(imports.router)

# routers/assistant.py is deliberately NOT mounted. It is the Ask AI feature, and
# the LLM stack it talked to has been retired, so /assistant/* answers 404 rather
# than spending its full timeout reaching for a host that is not listening. The
# module is kept on disk: restoring the import and this line, plus AI_ENABLED=1 and
# a running model server, is the whole of turning it back on.


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}


@app.get("/healthz", tags=["meta"])
async def healthz(response: Response):
    """Readiness probe: liveness plus a real database round-trip.

    Returns 200 with db="up" when the pool can serve a query, otherwise
    503 with db="down" so orchestrators can gate traffic.
    """
    try:
        pool = db.get_pool()
        await pool.fetchval("SELECT 1")
        return {"status": "ok", "db": "up"}
    except Exception as exc:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "error", "db": "down", "detail": str(exc)}
