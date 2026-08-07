from contextlib import asynccontextmanager
from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from . import db
from .config import settings
from .repositories import feedback as feedback_repo
from .repositories import import_issues as import_issues_repo
from .repositories import user as user_repo
from .routers import assistant, devices, feedback, handovers, imports, maintenance, users

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    # Schema changes are applied here, idempotently, because schema.sql only runs
    # on a fresh volume — the deployed database holds real data and must never be
    # recreated to pick up a column. Each of these is also mirrored in schema.sql
    # so a fresh machine gets the same shape.
    await feedback_repo.ensure_table(db.get_pool())
    await import_issues_repo.ensure_table(db.get_pool())
    await user_repo.ensure_columns(db.get_pool())
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

app.include_router(devices.router)
app.include_router(handovers.router)
app.include_router(maintenance.router)
app.include_router(users.router)
app.include_router(feedback.router)
app.include_router(assistant.router)
app.include_router(imports.router)


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
