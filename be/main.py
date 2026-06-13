from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from . import db
from .config import settings
from .routers import devices, handovers, maintenance, teams, users

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
app.include_router(teams.router)
app.include_router(users.router)


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}
