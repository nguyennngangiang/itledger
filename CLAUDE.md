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
  extract.py        Client for the LLM server's /rag/extract (Ask AI file uploads)
  glossary.py       bilingualize(): append Vietnamese synonyms of English IT terms
  constants.py      GHOST_CODE / IT_HELD_STATUSES — imports nothing, so anything may import it
  migrations.py     Idempotent startup DDL, in order. Run once from the lifespan
  models/           Pydantic schemas (Create / Update / Out / Delete) per resource
                    + page.py: Page[T], Ranked, ImportResult shared by every router
  repositories/     ALL SQL lives here (one module per resource) + errors.py
                    + _crud.py: Table spec, Where, paginate, soft-delete family
  routers/          Thin HTTP layer — parse, call repo. Domain errors → 409 in main.py
  sql/schema.sql    Table DDL (run once by Postgres on first container start)
  sql/migrations/   Hand-applied SQL for anything too heavy for startup
  seed.py           Idempotent sample-data seeder
  docker-compose.yml       Postgres + API (dev: hot reload, ports on 0.0.0.0)
  docker-compose.prod.yml  LAN overlay: no reload, restart policy, loopback ports

ai/                 Local semantic-search embedding service (runs on the HOST)
  main.py           FastAPI: POST /rank; OpenVINO on the Intel NPU (GPU/CPU fallback)
  run-host.ps1      Launcher: creates the .venv and starts uvicorn on :8010
  requirements-host.txt  openvino + tokenizers + fastapi (Python 3.12)
  .models/          multilingual-e5-small ONNX + tokenizer (gitignored)
  .venv/            Python 3.12 venv (gitignored)

deploy/             LAN deployment — see deploy/README.md
  Caddyfile.site    The :10000 site block (SPA + /api proxy), imported by D:\LLM\caddy
  start-itledger.ps1  Idempotent starter: containers + embedder + shared Caddy
  register-task.ps1   One-time ITLedger-AutoStart registration (run elevated)
  fetch-model.ps1     Downloads the e5-small ONNX + tokenizer

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
`AI_URL=http://host.docker.internal:8010`. Both containers hot-reload via the
mounted repo. `schema.sql` only runs on a fresh volume — after schema edits,
recreate: `docker compose down -v && docker compose up`.

**Seed sample data:** `python -m be.seed` (needs `DATABASE_URL`, or run inside
the api container). Idempotent.

**AI service (host, NPU) — embedding only:** the AI service is an
**embedding-only** semantic-search ranker (the generative LLM lives elsewhere —
see "LLM" below). It runs on the Windows host so it can use the Intel **NPU** (a
container can't reach it). `npm run dev` from `fe/` launches it (or run it alone
with `npm run dev:ai` /
`powershell -ExecutionPolicy Bypass -File ai\run-host.ps1`). It serves **`:8010`**
(`AI_PORT` overrides; **not** 8001 — on the deployment host that port belongs to
the LLM stack's `llm-rag` container) with a single `POST /rank`, compiling the
**multilingual-e5-small** ONNX model with OpenVINO, preferring
**NPU → GPU → CPU** (`EMBED_DEVICES`, first device that can run it wins); the
static [1, 128] reshape in `main.py` is what lets the NPU run it. It's
**multilingual** (~100 languages incl. Vietnamese) — e5 needs the `query: ` /
`passage: ` prefixes (handled in `main.py`); pooling is attention-masked **mean**
(not CLS). `/health` reports the bound `device`. Model files live in
`ai/.models/e5-small/` (`model.onnx` + `tokenizer.json`, gitignored; fetch them on
a fresh machine with `deploy\fetch-model.ps1`, which pulls `onnx/model.onnx` +
`tokenizer.json` from the `Xenova/multilingual-e5-small` HF repo).
**On the current deployment host there is no Intel NPU** — `openvino` reports
`['CPU']` (the GPU is an NVIDIA RTX 5060, which OpenVINO cannot target), so it
binds CPU. That needs no configuration: `main.py` skips devices absent from
`core.available_devices`. Don't "fix" a `device: "CPU"` in `/health` there.

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
embeds with the app's **own NPU service** `ai/` e5-small on `:8010` — a *different*
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
follow-ups resolve. It also **reads attached files**: the Ask AI chat accepts
uploads (image / PDF / DOCX / XLSX / CSV / TXT); the backend (`be/extract.py`)
forwards each to the LLM server's `POST /rag/extract` (parses office/PDF docs,
OCRs scanned PDFs & images via the vision model), and folds the extracted
text + tables into the prompt as an `ATTACHED FILES` block so the answer combines
files with fleet data. Falls back to a plain grounded completion if the model can't
tool-call. **Learning is project-local**: marked-correct rows in this project's
`search_feedback` table are injected as few-shot examples into the rerank/explain
prompts — the shared model is **never** fine-tuned. If the LLM is unreachable,
rerank falls back to semantic order and ask/explain return 503 (search still works).

**Frontend + AI (`npm run dev`):** from `fe/`, `npm install` then `npm run dev`
(http://localhost:5173) — this runs **Vite + the host AI embedder (:8010)**
together via `concurrently` (see `dev:*` scripts). Vite calls the API at
`VITE_API_URL` (default `http://localhost:8000`). So the full local stack is
`docker compose up` (DB + API) plus `npm run dev` (web + AI). `npm run build`
type-checks (`tsc -b`) then builds; run it to verify TS changes. `npm run lint`
for ESLint.

**LAN deployment (the office server) — read `deploy/README.md` before touching
it.** The app is live on the internal network at **http://192.168.3.252:10000**,
restored after reboot by the `ITLedger-AutoStart` scheduled task (AtStartup, plus a
5-minute idempotent watchdog) running `deploy\start-itledger.ps1`. Three things
there differ from the dev story above and *will* mislead you otherwise:

1. **The Caddy that serves this app is not ours.** It's the `D:\LLM\caddy\caddy.exe`
   process that fronts the LLM stack on `:8443`; it also serves `:10000` because
   `D:\LLM\caddy\Caddyfile` ends with `import "D:/itledger/deploy/Caddyfile.site"`.
   One process, two sites — so `deploy/Caddyfile.site` is ours but the file that
   loads it is not, and that Caddyfile's `admin off` means **`caddy reload` does not
   work** (stop + restart instead). Caddy serves `fe/dist` statically and proxies
   `/api/*` → `127.0.0.1:8000`, stripping the prefix, so prod runs same-origin and
   **CORS is never exercised** (`fe/.env.production` sets `VITE_API_URL=/api`).
2. **`docker compose` must run *inside* WSL there**, never from Windows: the
   Windows `DOCKER_HOST` points at a *different* engine than the `Ubuntu-24.04`
   distro that hosts these containers, and the api service bind-mounts the repo, so
   the daemon has to see it as `/mnt/d/itledger`. Use the `-f docker-compose.yml -f
   docker-compose.prod.yml` pair; the overlay needs `!override` on `ports` because
   Compose *appends* list values when merging.
3. **Python 3.12 is vendored at `.python312\`** (gitignored, portable NuGet build)
   because MSI installs are blocked by system policy on that host — the python.org
   installer exits `1625` and there is no `winget`. `ai/run-host.ps1` builds the
   venv from it; `$env:ITLEDGER_PYTHON` overrides.

Beware the Caddy directive-order trap if you edit `deploy/Caddyfile.site`: Caddy
sorts directives by its own order, not source order, and `try_files` sorts *before*
`handle`. A bare site-level `try_files` therefore rewrites `/api/health` to
`/index.html` before `handle_path /api/*` can match, and every API call silently
returns the SPA. Both handlers must be `handle` blocks.

## Conventions

- **Router stays thin; SQL only in `repositories/`.** Never string-format user
  values into SQL — use asyncpg `$1, $2` placeholders. Identifiers (table,
  `ORDER BY` column) can't be parameters, so they are allow-listed in one
  `_crud.Table` spec per resource and validated at import; read the docstring in
  `repositories/_crud.py` before touching that path. A rejected `order_by` is
  *replaced* with the default, never rejected-then-used.
- **Domain errors are mapped centrally.** `DuplicateError` / `ForeignKeyError` /
  `InUseError` / `ProtectedError` all become 409 via `app.add_exception_handler`
  in `main.py`, so routers don't catch them. `ValueError` deliberately is *not*
  mapped — Pydantic and the stdlib raise it, and a global handler would hide
  real bugs behind 4xx. 404s stay as explicit one-liners in each router.
- **Soft delete / trash.** `delete` sets `deleted_at`; `restore` clears it;
  `purge` (or `?permanent=true`) hard-deletes. List endpoints take `deleted`
  to switch between active rows and the trash. All four resources delegate to
  `_crud`; per-resource policy (the ghost guard, still-owns-devices) wraps it in
  the repo rather than living in the helper. `restore` is idempotent on purpose
  — see its docstring before "fixing" the missing guard.
- **Purging can be refused.** Handovers and maintenance FK to `devices`, and
  handovers FK to `users`, with no cascade — so a row with history returns 409,
  not 500. That is 216 of 327 devices on the live ledger: the common case.
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
- **Keyword search reaches the owner.** A row stores its owner as an
  `employee_code` FK, so plain `ILIKE` over the row's own columns can only match
  the *code* — typing a person's name found nothing until `owner_match()` /
  `device_owner_match()` (`be/repositories/__init__.py`) existed. Use those
  helpers in any new search predicate: they `EXISTS`-join `users` (never `JOIN`,
  which would break the `count(*)` total) and wrap the name in `unaccent()` so
  "van" finds "Vân". Vietnamese text columns are `unaccent()`-wrapped for the
  same reason; the extension is created in `be/sql/schema.sql`.
- **Semantic search.** `GET /<resource>/semantic-search?q=` exists for
  **devices, maintenance and handovers**. Each flattens an active row into a
  natural-language sentence (device: specs + owner team + repair count;
  maintenance: the repair story + device + team; handover: device + who
  gave/received + reason), calls the `ai` service `/rank`, and returns the rows
  with a `score`, and `?rerank=true` re-sorts them with the LLM. **These are
  backend-only today.** The per-screen "Smart" toggle, the relevance meter and
  "why matched" popover (`lib/relevance.tsx` `useSmartProof`), the rerank toggle
  and the mark-correct button that fed `search_feedback` were all **removed from
  the frontend** — the screens now filter as-you-type through `usePagedList`
  (see the note at the top of `fe/src/api/devices.ts`). The one remaining
  frontend consumer of the ranking path is **Ask AI**, which lives in the
  **header**, not on the Devices screen (`App.tsx`), and reaches it through the
  assistant's `semantic_search` tool. The embedder itself is local/offline — no
  external API; it runs on the host via OpenVINO, preferring the **Intel NPU**
  (see the AI service note above); the Docker API reaches it at
  `AI_URL` (`host.docker.internal:8010`).
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
- **Employee names in `REAL-DATA.xlsx` are not trustworthy per-cell**, so
  `_build_import.mjs` treats every name as a *candidate* and settles each code
  **after** all sheets are read — precedence comes from source trust, never sheet
  order (an as-you-go rule let whichever sheet ran first win, which is how
  VPHN216 became "Nguyễn Thị Vân"). The ranking, and why:
  1. **Handover History** — pairs a full name with that person's own code in
     adjacent cells. Most reliable.
  2. **`Devices` "Remark"** — holds most of the workbook's full names (~92 of 117
     values), but on some rows it holds the *previous* holder's name or a plain
     note, so it must never outrank Handover.
  3. **`Devices` "Name"** — always the right person but the worse rendering
     (nicknames, unaccented short forms like "Bui Thuy").

  A one-word value is a nickname, not a name, and is dropped rather than stored.
  Case-only variants are merged; `NOT_A_NAME` rejects note-shaped cells. The build
  writes `import_names_report.json` beside `import_data.json`: `conflicts` (one
  code, two different people — needs a human), `variants` (same person, merged),
  `missing` (nickname only). Extend the ranking rather than special-casing rows.
- **To correct names in a live DB, use `python -m be.fix_user_names`** (dry run;
  `--apply` writes) — **not** `be.import_real`, which `TRUNCATE`s all five tables
  and would discard everything entered in the app since the first import. It only
  ever writes `users.name`, never adds or deletes users, and dumps the table to
  `users_before_name_fix.json` before its first write. A `conflicts` code is only
  written if `NAME_DECISIONS` in that script records a human's ruling *and* the
  workbook still resolves to it; record new rulings there with who and when.
