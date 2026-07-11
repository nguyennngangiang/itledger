"""Central app settings, read from environment variables.

One place owns DATABASE_URL and CORS origins so nothing else has to call
os.getenv. Values are loaded from be/.env on import.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


class Settings:
    database_url: str = os.getenv(
        "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/itledger"
    )
    # Comma-separated list of allowed browser origins (the Vite dev server).
    cors_origins: list[str] = os.getenv(
        "CORS_ORIGINS", "http://localhost:5173"
    ).split(",")
    # Local semantic-search embedding service (see ai/main.py). The same host
    # service also proxies the local LLM (Ollama) for rerank / explain / ask,
    # so the backend only ever talks to ai_url — never Ollama directly.
    ai_url: str = os.getenv("AI_URL", "http://localhost:8001")


settings = Settings()
