# The LLM: what exists, what it did, and how to bring it to the VPS

Everything model-shaped in this project, written down in one place, because it is
currently **switched off** and a switched-off subsystem is the easiest kind to
misunderstand. Read this before deciding whether it comes to the VPS at all.

Short version: the app talks OpenAI-compatible HTTP to a server it does not own.
That server was a GPU box in the office. A typical Linux VPS has no GPU, so the
honest choices are **point the app at a hosted API** (three environment variables,
no code) or **leave the model where the GPU is** and reach it over a private
network. Copying 18 GB of Ollama onto a CPU-only VPS is the one option that looks
like the obvious answer and is not.

---

## 1. Two different things called "AI". Do not conflate them.

| | **The LLM** (this document) | **The embedder** (`ai/`) |
|---|---|---|
| What | `llama3.1:8b` etc. via Ollama | `multilingual-e5-small` via OpenVINO |
| Does | Generates text, reads files, reranks | Turns a sentence into a vector |
| Ran on | `D:\LLM`, GPU, port `:8443` | This repo, host process, port `:8010` |
| Talks to it | `be/llm.py`, `be/extract.py` | `be/search.py` |
| Config | `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | `AI_URL` |
| State | off, stack retired | off, not started by the deployment |

The LLM server also *hosts* an embedding model (`nomic-embed-text`), which the app
has never used — smart search always went to `ai/`. Two embedding systems, one of
them unused. `be/LLM_API.md` says the same thing at the top, in a note, for the
same reason.

## 2. What is in the app

All of it is intact in the repo. Nothing was deleted when it was switched off.

| File | What it is |
|---|---|
| `be/llm.py` | The **only** module that calls the LLM. Chat, streaming chat, an agentic tool loop, `explain`, `rerank`, `warm` |
| `be/extract.py` | Client for `POST /rag/extract` — parses xlsx/docx/pdf, OCRs scans and photos |
| `be/routers/assistant.py` | Ask AI: `POST /assistant/ask` and `/assistant/explain`. **Not mounted** in `be/main.py` |
| `be/LLM_API.md` | Full API reference for the server: every endpoint, request/response shapes, curl/Python/PowerShell examples |
| `be/config.py` | `ai_enabled` plus the four `LLM_*` / `RAG_*` settings |
| `be/documents.py`, `be/glossary.py` | Row → sentence flattening and the EN↔VI term map. Shared with the embedder, still used |

### The switch

`AI_ENABLED` in `be/.env`, default **0**. It is a master switch, not a hint —
every call site that leaves this host for a model checks it:

- `be/extract.py` refuses up front with a 503 and a message naming the Excel
  template, rather than an outage the user could retry into.
- `be/routers/imports.py` skips the "ask the model when unsure" branch in kind
  detection, and refuses `reader: "llm"` on handover import.
- `be/llm.rerank_results` returns its input untouched instead of burning a 180 s
  timeout to arrive at the same list.
- `be/main.py` does not mount the assistant router, so `/assistant/*` answers 404
  instead of hanging.

### What the model used to do, and what happens now without it

| Feature | Without the model |
|---|---|
| **Ask AI** — agentic Q&A across devices/maintenance/handovers, multi-turn, reads attached files | Gone. Router unmounted, UI removed (commit `96003dc` deleted `fe/src/api/assistant.ts` and `fe/src/components/Modal/AssistantModal.tsx`) |
| **Rerank** on `?rerank=true` for the three `/semantic-search` endpoints | Falls back to the embedder's order. Those endpoints have no frontend caller anyway |
| **Explain** why a search result matched | Gone with Ask AI |
| **Reading a handover record** from a PDF, a photo, or an off-template sheet | Refused with a clear message. **The company Excel template still imports** — `be/handover_sheet.py` parses it in plain code, and always did; the model was only ever the fallback |
| **Import kind detection** when the heuristics are unsure | Heuristics only. The screen always showed the guess with an override, so an unsure answer costs one click either way |

The one that matters operationally: **handover import from the company template
does not need a model** and never did. Measured on this hardware, the same
fifteen-row record took **0.2 s** parsed and **68 s** through the model.

## 3. What is on the server (`D:\LLM`)

Still on disk, containers deleted, nothing running. 18 GB total.

| Piece | Size | What |
|---|---|---|
| `models/` | **12 GB** | Ollama blobs: `llama3.1:8b`, `qwen2.5vl:7b`, `nomic-embed-text`, `bge-m3` |
| `rag/` | 1.1 GB | FastAPI service: `/rag/chat` (retrieval + citations), `/rag/extract` (the one the app used), a deterministic packing-list extractor |
| `ocr/` | 7 KB | PaddleOCR service (models download into a volume) |
| `searxng/` | 1 KB | Web search for the RAG service. Never used by this app |
| `caddy/` | 52 MB | **Native Windows** Caddy on `0.0.0.0:8443`. The Bearer-key gate |
| `ollama/` | 1.9 GB | The old native `ollama.exe`, superseded by the container |
| `compose.yml` | — | ollama + rag + ocr + searxng, `llmnet`, NVIDIA GPU reservation |

The entry point is Caddy, not Ollama. `D:\LLM\caddy\Caddyfile` rejects anything
without `Authorization: Bearer <LLM_API_KEY>` with a 401, then routes `/rag/*` to
the RAG service on `127.0.0.1:8001` and **everything else** to Ollama on
`127.0.0.1:11434`. That is why the app's base URL is `…:8443/v1` and why one key
covers both `/v1/chat/completions` and `/rag/extract`.

### Measured numbers, all on an RTX 5060 (8 GB VRAM), 32 GB RAM

| | |
|---|---|
| `llama3.1:8b` cold — first token | **~44 s** (weights into VRAM) |
| `llama3.1:8b` warm — first token | ~0.6 s |
| Generation, warm | ~47 tok/s |
| Idle eviction | 10 min (`OLLAMA_KEEP_ALIVE`) |
| Resident cost while loaded | ~6 GB RAM, ~88 % of 8 GB VRAM |

The 44 s cold load is why `be/llm.warm()` and `POST /imports/llm/warm` exist: the
import dialog fires the warm call when it opens, and the progress bar names the
`loading` phase instead of hiding it behind a spinner.

That resident cost is also why the stack was retired. It was holding ~6 GB of RAM
and most of a GPU around the clock to serve one header button.

## 4. Bringing it back on the office box (no VPS involved)

1. `AI_ENABLED=1` in `be/.env`, plus `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
   `RAG_EXTRACT_URL` — see `be/.env.example`. The key is in `D:\LLM\API_KEY.txt`.
2. Start the stack: `powershell D:\LLM\manage.ps1 up` (it runs `docker compose` inside
   the `Ubuntu-24.04` WSL distro, same as this app).
3. Start the native Caddy on `:8443` from `D:\LLM\caddy`.
4. Restart the API container.

That restores rerank, `/rag/extract` (so PDFs and photos read again) and the LLM
fallback in import. **Ask AI needs two more things**: mount the router in
`be/main.py` (the comment there says exactly where), and restore the frontend by
reverting the `fe/` half of commit `96003dc`.

## 5. Bringing it to a Linux VPS

### The problem, stated plainly

`llama3.1:8b` at Q4 is ~5 GB of weights. On the office GPU it answers at ~47
tok/s. On a CPU-only VPS the same model runs roughly **3–8 tok/s** on 4–8 vCPUs —
a 300-token answer becomes one to two minutes, before the cold-load penalty, which
on CPU is worse than 44 s. Ask AI is an interactive header button; at that speed it
is not a feature, it is a complaint. The RAG and OCR services need another ~8 GB of
RAM on top.

So: **do not copy `D:\LLM` onto an ordinary VPS and expect it to work.** Decide
which of these you actually want.

### Option A — hosted API. Three environment variables, zero code. **Recommended.**

`be/llm.py` speaks plain OpenAI Chat Completions and already sends a Bearer header.
Anything OpenAI-compatible drops in:

```
AI_ENABLED=1
LLM_BASE_URL=https://api.anthropic.com/v1   # or any OpenAI-compatible endpoint
LLM_API_KEY=<key>
LLM_MODEL=<model id>
```

- Nothing to host, no GPU, no 44-second cold start, and answers get *better* than
  `llama3.1:8b`, not worse.
- Costs money per token, and **fleet data leaves the building** — Ask AI puts real
  device serials, employee names and codes into the prompt. That is a decision for
  whoever owns the data, not a technical detail. If it is a no, this option is out.
- `POST /rag/extract` has no hosted equivalent, so **PDF/photo import stays off**
  unless you also do Option B or C. Excel import is unaffected.

### Option B — leave the model on the office GPU, reach it from the VPS

The office box keeps `D:\LLM`; the VPS sets `LLM_BASE_URL` to it over a private
link (WireGuard or Tailscale — **not** a port forward: the only thing in front of
`:8443` is a Bearer key over plain HTTP).

- Keeps the GPU you already paid for, and no data leaves the company.
- The VPS now depends on the office internet and on that machine being up, which is
  most of what moving to a VPS was meant to escape.
- Sensible if Ask AI is wanted but the fleet data must stay internal.

### Option C — GPU VPS, lift the stack as-is

Only worth it if both "keep the data in-house" and "no office dependency" are hard
requirements. Needs ≥8 GB VRAM, ~16 GB RAM, ~40 GB disk.

What to copy and what changes:

| Copy | Note |
|---|---|
| `D:\LLM\models\` (12 GB) | The blobs. Copy them and Ollama re-downloads nothing. `rsync` or an external disk — do not pull them over the office uplink twice |
| `D:\LLM\rag\`, `ocr\`, `searxng\` | Build contexts. `.venv/` and `data/` do not need to travel |
| `D:\LLM\compose.yml` | Works on Linux as-is, but the host path `/mnt/d/LLM/models:/models` becomes the VPS path |
| `D:\LLM\caddy\Caddyfile` | Rewrite: the log path is `D:\LLM\...`, and native Windows Caddy becomes a container or a systemd unit |
| `D:\LLM\.env` | **Rewrite by hand, do not copy** — see §6 |

Also needed on the VPS: NVIDIA drivers plus `nvidia-container-toolkit`, or the
`deploy.resources.reservations.devices` block in `compose.yml` fails to start.

Put it behind the same Caddy that serves the app (`deploy/vps/Caddyfile`) rather
than exposing `:8443` publicly, and keep Ollama and the RAG service on loopback.

### Option D — a small model on CPU

`llama3.2:3b` or `qwen2.5:3b` will run on a CPU VPS at a usable speed. Good enough
for rerank and short structured reads; **not** good enough for Ask AI's agentic
tool loop, which needs reliable tool-calling. Treat this as "rerank comes back",
not "the assistant comes back".

### Whichever you pick

`AI_ENABLED` stays the switch, and the app needs no code change for any of A, B or
D. Only the Ask AI **UI** needs the `96003dc` revert, in every case.

## 6. Secrets — read before copying anything

- `D:\LLM\API_KEY.txt` and `D:\LLM\.env` hold the Bearer key that is the **only**
  thing standing in front of the model server. `:8443` is plain HTTP.
- `D:\LLM\.env` also contains a long-lived **Claude Code OAuth token**
  (`CLAUDE_CODE_OAUTH_TOKEN`) used by a headless supervisor script. It is a live
  credential on someone's account and has nothing to do with running the models.
  **Do not copy that file to the VPS**; write a fresh `.env` with only the
  `LLM_API_KEY` / `RAG_*` variables the stack needs, and rotate that token if the
  file has ever been shared.
- Generate a **new** `LLM_API_KEY` for the VPS rather than moving this one. The old
  one has been in a LAN Caddyfile, a log or two, and this repo's history of
  `.env.example` placeholders.
- `be/.env` is gitignored and does not travel. Write it on the VPS.

## 7. Where to read more

- `be/LLM_API.md` — every endpoint with worked examples. The reference.
- `D:\LLM\README.md`, `D:\LLM\CLAUDE.md` — the stack's own documentation.
- `D:\LLM\rag\ARCHITECTURE.md` — how the RAG service is put together.
- `deploy/vps/README.md` — the rest of the move, and the traps in it.
- `CLAUDE.md` (repo root) — the "LLM (generative)" section, which is the app's view.
