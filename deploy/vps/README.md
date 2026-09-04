# Moving IT Ledger to a Linux VPS

Everything in this directory exists for one job: getting the app off the Windows
office server (`192.168.3.252:10000`, Caddy + WSL2 + Docker) and onto a Linux VPS,
with the ledger's data intact.

Read this whole file before running anything. It is written for whoever — or
whatever — does the deploy on the far side, and the parts that will waste your day
are called out rather than left to be discovered.

## The shape of it

| Piece | What runs it | Listens on |
|---|---|---|
| SPA (`fe/dist`) + `/api` proxy | Caddy on the host | `:80` / `:443` |
| API (FastAPI) | container, `deploy/vps/Dockerfile.api` | `127.0.0.1:8000` |
| Postgres 16 (`unaccent`) | container | nothing published |

**There is no AI service.** Ask AI, the LLM reranker and OCR file-extraction were
removed when the `D:\LLM` stack was retired. `AI_ENABLED=0` is the deployed state,
nothing calls out to a model, and handover import works from Excel files matching
the company template via plain parsing in `be/handover_sheet.py`. Do not go looking
for an embedder or an Ollama to stand up — `ai/` and `deploy/fetch-model.ps1` are
dormant code, not a missing dependency.

## Files here

| File | Purpose |
|---|---|
| `dump-db.sh` | Run **on the Windows server, inside WSL**. Writes a verified backup directory |
| `restore-db.sh` | Run **on the VPS**. Restores that directory and proves the row counts match |
| `docker-compose.vps.yml` | The whole stack for Linux. Replaces the Windows compose pair |
| `Dockerfile.api` | Real API image, instead of the bind-mount + pip-at-startup dev setup |
| `Caddyfile` | Site block with Linux paths. **Draft — set the hostname and root** |
| `.env.example` | Copy to `.env`; `POSTGRES_PASSWORD` is required |

`docker-compose.vps.yml`, `Dockerfile.api` and `Caddyfile` were written on the
Windows server and **have never been started on a Linux host**. They are a correct
starting point, not a tested artifact. Expect to adjust the hostname, the repo
path and possibly the Postgres major version.

## What is NOT in the repo

A fresh `git clone` will not run. These are gitignored and have to be put back:

- **`be/.env`** — copy `be/.env.example`. For the VPS the whole file is three
  lines: `DATABASE_URL`, `CORS_ORIGINS`, `AI_ENABLED=0`. All the `LLM_*` and
  `AI_URL` entries in the example are dead while `AI_ENABLED=0`; leave them out.
  (With `docker-compose.vps.yml` the API gets these from compose instead, so
  `be/.env` is only needed if you run the API outside a container.)
- **`fe/dist/`** — build it: `cd fe && npm ci && npm run build`. `fe/.env.production`
  is tracked and already says `VITE_API_URL=/api`; leave it alone.
- **`deploy/caddy.exe`** — a 53 MB vendored Windows binary. Irrelevant here; install
  Caddy from the distro.
- **`.python312/`** — a portable CPython for the embedder, which is off. Skip it.
- **The database.** That is what `dump-db.sh` / `restore-db.sh` are for.

## What in `deploy/` is Windows-only

`deploy/README.md` describes the office server, and three of its claims are false
on a VPS. Do not follow them:

- **"compose must run inside WSL"** — that is about the Windows host having two
  Docker engines. There is no WSL here; run `docker compose` directly.
- **`start-itledger.ps1`, `register-task.ps1`, `fetch-model.ps1`** — PowerShell,
  and the scheduled-task autostart they set up. Replaced by `restart: unless-stopped`
  in compose plus a systemd unit for Caddy.
- **`deploy/Caddyfile` + `Caddyfile.site`** — hard-code `D:/itledger/...` paths and
  `admin off`. `deploy/vps/Caddyfile` is the Linux version.

The rest of `deploy/README.md` — the Caddy directive-order trap especially — still
applies.

## Deploy, in order

```bash
git clone <repo> /srv/itledger && cd /srv/itledger
git checkout refactor/relations-and-code       # until it is merged to main

cp deploy/vps/.env.example deploy/vps/.env     # set POSTGRES_PASSWORD
$EDITOR deploy/vps/.env

cd fe && npm ci && npm run build && cd ..      # produces fe/dist

docker compose -f deploy/vps/docker-compose.vps.yml up -d --build
curl -s http://127.0.0.1:8000/healthz          # {"status":"ok","db":"up"}
```

Then the data — copy the backup directory over and:

```bash
bash deploy/vps/restore-db.sh backups/itledger-<stamp>
```

Then Caddy: edit `deploy/vps/Caddyfile` (hostname, `root * /srv/itledger/fe/dist`),
install it as `/etc/caddy/Caddyfile`, `systemctl reload caddy`.

## Three traps

**1. The container creates the schema for you.** Both compose files mount
`be/sql/schema.sql` into `/docker-entrypoint-initdb.d/`, so a fresh volume comes up
with the full but empty schema plus the `unaccent` extension and the `IT-STORE`
ghost user. The restore therefore lands on top of existing tables, which is why
`restore-db.sh` passes `--clean --if-exists`. Without it `pg_restore` reports
"relation already exists" for every table, carries on, and leaves a database that
looks restored and holds nothing.

**2. `pg_restore` cannot read a newer archive.** The dump is `-Fc` taken from
PostgreSQL **16.14**. Restoring into 16 or 17 is fine; into anything older it fails
on the header. That is why `dump-db.sh` also writes `itledger.sql` — plain SQL any
version can load with `psql`. Pin `postgres:16` unless you have a reason not to.

**3. The password.** `be/docker-compose.yml` and `be/docker-compose.prod.yml`
hard-code `poop`. That was tolerable behind an office LAN with Postgres bound to
loopback. `docker-compose.vps.yml` refuses to start without `POSTGRES_PASSWORD`
in `deploy/vps/.env` on purpose — do not paste the old one back in.

## Proving it worked

```bash
curl -s http://127.0.0.1:8000/healthz     # {"status":"ok","db":"up"} — real DB round-trip
curl -s https://<host>/api/health         # must be JSON, NOT the SPA's HTML
```

That second one is the whole test for the Caddy directive-order trap: if it returns
HTML, `try_files` is being sorted ahead of `handle_path` and every API call is
silently getting `index.html` with a 200. Fix it by making sure both handlers are
`handle` blocks — never a bare site-level `try_files`.

Row counts are checked by `restore-db.sh` against the manifest, so if it exited 0
the data is all there. To look anyway:

```bash
docker compose -f deploy/vps/docker-compose.vps.yml exec db \
  psql -U postgres -d itledger -c \
  "SELECT (SELECT count(*) FROM devices) devices, (SELECT count(*) FROM users) users,
          (SELECT count(*) FROM handovers) handovers, (SELECT count(*) FROM maintenance) maint"
```

## Where to read next

`CLAUDE.md` at the repo root is the architecture and conventions document — router
stays thin, SQL only in `repositories/`, soft delete, the import paths, the search
helpers. `PRODUCT.md` and `DESIGN.md` cover product and visual decisions.
`deploy/README.md` is the Windows deployment being replaced.
