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
    # MASTER SWITCH for everything that calls out to the chat LLM
    # (be/llm.py). Originally guarded a since-retired remote D:\LLM stack;
    # this VPS instead runs its own local Ollama (deploy/vps/docker-compose.
    # vps.yml), so AI_ENABLED=1 there — see that file for the real deployed
    # values. Guarded call sites: be/routers/imports.py (handover-reading
    # fallback), be/llm.rerank_results. be/routers/documents.py's Ask AI
    # (`/documents/ask`) does not check this — the WHOLE point of that
    # endpoint is talking to the LLM, so there is nothing to guard.
    ai_enabled: bool = os.getenv("AI_ENABLED", "0").strip().lower() in (
        "1", "true", "yes", "on",
    )

    # Internal-network OpenAI-compatible LLM (see be/llm.py). Key is a secret —
    # keep it in be/.env (gitignored), never in docker-compose.yml or git.
    # Inert while ai_enabled is false.
    llm_base_url: str = os.getenv("LLM_BASE_URL", "http://192.168.3.252:8443/v1")
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "llama3.1:8b")

    # Local embedding model — be/embeddings.py, used by be/routers/documents.py
    # (document RAG) AND be/search.py (the three /semantic-search endpoints +
    # the Ask AI fleet tools). Native Ollama API — no /v1 suffix, unlike
    # llm_base_url. Independent of ai_enabled: see be/embeddings.py.
    embed_base_url: str = os.getenv("EMBED_BASE_URL", "http://ollama:11434")
    embed_model: str = os.getenv("EMBED_MODEL", "bge-m3")

    # Claude reads supplier paperwork and device labels for the Scan screen
    # (be/scan.py) through `claude -p` on the HOST — deploy/vps/claude-runner.py,
    # reached over this unix socket (bind-mounted into the container). It uses
    # the host's logged-in Claude account; there is no API key.
    claude_runner_socket: str = os.getenv("CLAUDE_RUNNER_SOCKET", "/run/itledger-claude/claude.sock")
    scan_model: str = os.getenv("SCAN_MODEL", "claude-opus-5-5")


settings = Settings()
