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
    # Local semantic-search embedding service (see ai/main.py) — embedding-only.
    # Not started by the deployment any more: the three /semantic-search endpoints
    # it backs were only ever called by Ask AI. See `ai_enabled` below.
    ai_url: str = os.getenv("AI_URL", "http://localhost:8001")

    # MASTER SWITCH for everything that leaves this host to reach a model, and it
    # is OFF unless someone sets it. The LLM stack at D:\LLM was retired — it held
    # ~6 GB of RAM and 88% of the GPU's VRAM resident to serve one button — so the
    # endpoints below answer nothing, and code that calls them would hang for its
    # full timeout before failing. Guarded call sites: be/extract.py,
    # be/routers/imports.py, be/llm.rerank_results. The Ask AI router is not
    # mounted at all (see be/main.py).
    #
    # Turning this back on takes three things: AI_ENABLED=1, the LLM_* variables
    # restored to be/.env, and the D:\LLM stack running. The Ask AI *UI* is gone
    # from the frontend and would need a revert on top of that.
    ai_enabled: bool = os.getenv("AI_ENABLED", "0").strip().lower() in (
        "1", "true", "yes", "on",
    )

    # Internal-network OpenAI-compatible LLM (see be/llm.py). Key is a secret —
    # keep it in be/.env (gitignored), never in docker-compose.yml or git.
    # Inert while ai_enabled is false.
    llm_base_url: str = os.getenv("LLM_BASE_URL", "http://192.168.3.252:8443/v1")
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "llama3.1:8b")
    # File-extraction endpoint on the same LLM server (Caddy :8443). Parses
    # xlsx/docx/pdf and OCRs scanned PDFs/images (via qwen2.5vl) — see be/extract.py.
    # NOT under /v1; uses the same Bearer key.
    rag_extract_url: str = os.getenv(
        "RAG_EXTRACT_URL", "http://192.168.3.252:8443/rag/extract"
    )


settings = Settings()
