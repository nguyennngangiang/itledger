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
  llm.py            Internal OpenAI-compatible client: chat / chat_agent (tools) / rerank
  LLM_API.md        Reference for the internal LLM/RAG server (endpoints, models, examples)
  documents.py      Shared row→sentence flatteners (bilingual) for search + assistant
  search.py         Shared client for the ai `/rank` embedder
  glossary.py       bilingualize(): append Vietnamese synonyms of English IT terms
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
(`5432`) and the API (`8000`, `/docs` for Swagger). The AI embedder runs on the
**host**, not in Docker (see below) — the API reaches it at
`AI_URL=http://host.docker.internal:8001`. Both containers hot-reload via the
mounted repo. `schema.sql` only runs on a fresh volume — after schema edits,
recreate: `docker compose down -v && docker compose up`.

**Seed sample data:** `python -m be.seed` (needs `DATABASE_URL`, or run inside
the api container). Idempotent.

**AI service (host, NPU) — embedding only:** the AI service is an
**embedding-only** semantic-search ranker (the generative LLM lives elsewhere —
see "LLM" below). It runs on the Windows host so it can use the Intel **NPU** (a
container can't reach it). `npm run dev` from `fe/` launches it (or run it alone
with `npm run dev:ai` /
`powershell -ExecutionPolicy Bypass -File ai\run-host.ps1`). It serves `:8001`
with a single `POST /rank`, compiling the **multilingual-e5-small** ONNX model
with OpenVINO, preferring **NPU → GPU → CPU** (`EMBED_DEVICES`); the static
[1, 128] reshape in `main.py` is what lets the NPU run it. It's **multilingual**
(~100 languages incl. Vietnamese) — e5 needs the `query: ` / `passage: `
prefixes (handled in `main.py`); pooling is attention-masked **mean** (not CLS).
`/health` reports the bound `device`. Model files live in `ai/.models/e5-small/`
(`model.onnx` + `tokenizer.json`, gitignored; a fresh machine downloads them from
the `Xenova/multilingual-e5-small` HF repo — `onnx/model.onnx` + `tokenizer.json`).

**LLM (generative — Ask AI, explain, rerank):** a separate **internal-network
OpenAI-compatible** endpoint — a Caddy-fronted model server on `:8443` requiring
`Authorization: Bearer <LLM_API_KEY>`. The **backend** calls it directly via
`be/llm.py` (chat completions + `chat_agent` agentic tool loop +
`explain`/`rerank`/`rerank_results` helpers), which already sends the Bearer
header. Config in `be/config.py` from `be/.env` (gitignored): `LLM_BASE_URL`
(`…:8443/v1`), `LLM_API_KEY` (secret), `LLM_MODEL` — see `be/.env.example`. The
server hosts three models (pick via `model`): **`llama3.1:8b`** — text chat, the
one this app uses (`LLM_MODEL`); `qwen2.5vl:7b` — multimodal (reads images:
OCR/tables), unused for now; `nomic-embed-text` — embeddings, unused (smart-search
embeds with the app's **own NPU service** `ai/` e5-small on `:8001` — a *different*
embedder, don't conflate). It also exposes Ollama-native (`/api/*`) and RAG
(`/rag/chat` with citations) endpoints, unused by the app. **Full endpoint list +
request/response examples (text, images, RAG, embeddings, curl/Python/PowerShell)
live in `be/LLM_API.md`.** Powers `POST /assistant/ask` (**cross-resource, agentic**
fleet-grounded Q&A), `POST /assistant/explain` (why a result matched), and
`?rerank=true` on the three `semantic-search` endpoints. **Ask AI is agentic**: the
prompt carries an exact `FLEET STATS` block (counts are computed in Python, never
tallied by the LLM) and the model calls backend **tools** (`find_devices`,
`device_history` — the device+maintenance+handover JOIN — and `semantic_search`
over any one resource) to fetch detail, so it answers questions that span all
three resources. It's **multi-turn**: the frontend sends recent chat `history` so
follow-ups resolve. Falls back to a plain grounded completion if the model can't
tool-call. **Learning is project-local**: marked-correct rows in this project's
`search_feedback` table are injected as few-shot examples into the rerank/explain
prompts — the shared model is **never** fine-tuned. If the LLM is unreachable,
rerank falls back to semantic order and ask/explain return 503 (search still works).

**Frontend + AI (`npm run dev`):** from `fe/`, `npm install` then `npm run dev`
(http://localhost:5173) — this runs **Vite + the host AI embedder (:8001)**
together via `concurrently` (see `dev:*` scripts). Vite calls the API at
`VITE_API_URL` (default `http://localhost:8000`). So the full local stack is
`docker compose up` (DB + API) plus `npm run dev` (web + AI). `npm run build`
type-checks (`tsc -b`) then builds; run it to verify TS changes. `npm run lint`
for ESLint.

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
- **Semantic search.** `GET /<resource>/semantic-search?q=` exists for
  **devices, maintenance and handovers**. Each flattens an active row into a
  natural-language sentence (device: specs + owner team + repair count;
  maintenance: the repair story + device + team; handover: device + who
  gave/received + reason), calls the `ai` service `/rank`, and returns the rows
  with a `score`. Each screen's **"Smart"** toggle swaps the normal search for
  the ranked results, rendered with the shared relevance meter + "why matched"
  proof popover (`lib/relevance.tsx` `useSmartProof`). Each screen also has an
  **LLM rerank** toggle (`?rerank=true`) and a **mark-correct** button that feeds
  `search_feedback` (project-local few-shot — see "LLM" above); the Devices screen
  adds an **Ask AI** chat. The embedder itself is local/offline — no external API;
  it runs on the host via OpenVINO, preferring the **Intel NPU** (see the
  AI service note above); the Docker API calls it at `host.docker.internal:8001`.
  The data is English but the team searches in Vietnamese, so each flattened
  document is **bilingually enriched** (`be/glossary.py` `bilingualize()`):
  recognised English IT terms get their Vietnamese synonyms appended, so a
  Vietnamese query matches same-language. Extend the glossary map for new terms.
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
