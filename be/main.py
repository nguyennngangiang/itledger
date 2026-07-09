from contextlib import asynccontextmanager
from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from . import db
from .config import settings
from .routers import devices, handovers, maintenance, users

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
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
