# IT Ledger

Internal web app for tracking company IT hardware: a **device inventory** with
**owners**, plus **maintenance** and **handover** history, and a **dashboard**
of fleet stats. FastAPI + PostgreSQL backend, React + Vite frontend.

## Layout

```
be/                 FastAPI backend (Python 3.12, asyncpg)
  main.py           App entry: lifespan (DB pool), CORS, router wiring, /health
  config.py         Settings from env (DATABASE_URL, CORS_ORIGINS, AI_URL) via be/.env
  db.py             Global asyncpg pool + get_pool() dependency
  models/           Pydantic schemas (Create / Update / Out / Delete) per resource
  repositories/     ALL SQL lives here (one module per resource) + errors.py
  routers/          Thin HTTP layer — parse, call repo, map errors to status codes
  sql/schema.sql    Table DDL (run once by Postgres on first container start)
  seed.py           Idempotent sample-data seeder
  docker-compose.yml  Postgres + API + AI containers

ai/                 Local semantic-search embedding service (runs on the HOST)
  main.py           FastAPI: POST /rank; OpenVINO on the Intel NPU (GPU/CPU fallback)
  run-host.ps1      Launcher: creates the .venv and starts uvicorn on :8001
  requirements-host.txt  openvino + tokenizers + fastapi (Python 3.12)
  .models/          bge-small-en-v1.5 ONNX + tokenizer (gitignored)
  .venv/            Python 3.12 venv (gitignored)

fe/                 React 19 + Vite 8 + TypeScript, Ant Design 6, Tailwind 4
  src/api/          One module per resource; all fetches go through client.ts
  src/components/   Screens (DeviceMainScreen, MaintenanceScreen, …) + Modal/
  src/lib/          format.ts, usePagedList.ts (server-side table hook), sparkle.ts (anime.js)
  src/types.ts      TS types mirroring the backend snake_case JSON
```

## Run it

**Backend + DB (Docker):** from `be/`, `docker compose up` starts Postgres
(`5432`) and the API (`8000`, `/docs` for Swagger). The AI stack (embedder +
Ollama) runs on the **host**, not in Docker (see below) — the API reaches it at
`AI_URL=http://host.docker.internal:8001`. Both containers hot-reload via the
mounted repo. `schema.sql` only runs on a fresh volume — after schema edits,
recreate: `docker compose down -v && docker compose up`.

**Seed sample data:** `python -m be.seed` (needs `DATABASE_URL`, or run inside
the api container). Idempotent.

**AI service (host, NPU):** the embedding service runs on the Windows host so it
can use the Intel **NPU** (a container can't reach it). `npm run dev` from `fe/`
launches it (or run it alone with `npm run dev:ai` /
`powershell -ExecutionPolicy Bypass -File ai\run-host.ps1`). It serves `:8001`
and compiles the bge-small-en-v1.5 ONNX model with OpenVINO, preferring
**NPU → GPU → CPU** (`EMBED_DEVICES`); the static [1, 128] reshape in `main.py`
is what lets the NPU run it. `/health` reports the bound `device`. Model files
live in `ai/.models` (already present; a fresh machine can copy them from a
teammate or re-download the `qdrant/bge-small-en-v1.5-onnx-q` repo).

**Ollama (LLM, host):** the generative features (`/explain`, `/rerank`, `/chat`
on the AI service) proxy a local **Ollama** LLM (`qwen2.5:7b`) also running on
the host at `:11434`. `npm run dev` starts it headless (no standalone GUI) via
`ai\run-ollama.ps1` — which reuses an already-running Ollama if one is up. Models
live in `~/.ollama` (persist across restarts); pull with `ollama pull qwen2.5:7b`
if missing. `/llm/health` on the AI service reports whether it's reachable/pulled.

**Frontend + AI stack (`npm run dev`):** from `fe/`, `npm install` then
`npm run dev` (http://localhost:5173) — this runs **Vite + the host AI embedder
(:8001) + Ollama (:11434)** together via `concurrently` (see `dev:*` scripts).
Vite calls the API at `VITE_API_URL` (default `http://localhost:8000`). So the
full local stack is `docker compose up` (DB + API) plus `npm run dev` (web + AI +
LLM). `npm run build` type-checks (`tsc -b`) then builds; run it to verify TS
changes. `npm run lint` for ESLint.

## Conventions

- **Router stays thin; SQL only in `repositories/`.** Never string-format user
  values into SQL — use asyncpg `$1, $2` placeholders. `ORDER BY` / filter
  columns are allow-listed (see `SORTABLE_FIELDS` / `FILTERABLE_FIELDS`).
- **Soft delete / trash.** `delete` sets `deleted_at`; `restore` clears it;
  `purge` (or `?permanent=true`) hard-deletes. List endpoints take `deleted`
  to switch between active rows and the trash.
- **Bulk delete.** Each resource exposes `DELETE /<resource>/batch` (id list in
  the body, `?permanent=`). Declared before `/{id}` so "batch" isn't read as an
  id. Frontend: `delete*Batch()` in `src/api/`, driven by the shared
  `BulkDeleteBar` + table `rowSelection`.
- **Import.** `POST /devices/import` bulk-inserts parsed rows and skips existing
  serials (`ON CONFLICT DO NOTHING`) so re-imports are idempotent. The Import
  button parses xlsx/csv client-side with `xlsx` (`ImportDevicesModal`); columns
  are matched to fields by normalized header name.
- **Paginated tables.** `GET /<resource>/page` returns `{rows, total}`; the
  `usePagedList` hook drives an Ant `<Table>` (sort/search/paginate/trash).
- **Semantic search.** `GET /devices/semantic-search?q=` flattens each active
  device into a sentence (specs, owner team, repair count), calls the `ai`
  service `/rank`, and returns devices with a `score`. The Devices screen's
  "Smart" toggle renders the ranked results with a relevance meter. It's local
  and offline — no external API. The embedder runs on the host via OpenVINO,
  preferring the **Intel NPU** (see the AI service note above); the Docker API
  calls it at `host.docker.internal:8001`.
- **Owners.** Ownerless / in-stock devices belong to the ghost `IT-STORE` user
  (`GHOST_USER_CODE`). `resolveOwner` in `lib/format.ts` handles display.
- **Animation (anime.js).** `lib/sparkle.ts` owns motion: click sparkle bursts,
  staggered entrances, springy button-press feedback, and the sliding nav
  indicator. Charts (chart.js) animate on mount. Respect
  `prefers-reduced-motion`.
- **API shape.** JSON is snake_case both ways; `client.ts` centralizes the base
  URL, JSON handling, and `ApiError` (FastAPI's `detail`). Keep `types.ts` in
  sync with the Pydantic models.

## Design Context

Design decisions live in `PRODUCT.md` (strategic) and `DESIGN.md` (visual system)
at the repo root — read them before UI work. Register is **product** (design
serves the task), platform **web**. Users are the IT/ops team (daily data entry)
plus managers (occasional read-only fleet checks); success is fleet visibility
and reporting. Core principles: delight in a chore, story over cells (devices
carry their full owner/maintenance/handover history), visibility at a glance,
familiar affordances with personality in the seams, and playful motion that
always has a reduced-motion fallback (WCAG 2.1 AA).

## Notes

- Root-level `REAL-DATA.xlsx`, `import_data.json`, `_build_import.mjs`, and
  `be/import_real.py` are one-off scaffolding used to bootstrap real data; the
  in-app Import button supersedes them for normal use. Data files are gitignored.
