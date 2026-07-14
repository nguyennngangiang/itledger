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
    ai_url: str = os.getenv("AI_URL", "http://localhost:8001")
    # Internal-network OpenAI-compatible LLM (see be/llm.py). Key is a secret —
    # keep it in be/.env (gitignored), never in docker-compose.yml or git.
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
