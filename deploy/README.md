# LAN deployment

Serves IT Ledger to the office network at **http://192.168.3.252:10000**, and brings
the whole stack back after someone logs in following a reboot.

> **Moving to a Linux VPS?** This file describes the Windows host, and several of its
> rules (compose must run inside WSL, the PowerShell autostart, the `D:/` paths in the
> Caddyfile) do not survive the move. Read [`vps/README.md`](vps/README.md) instead —
> it carries the Linux stack, the database dump/restore scripts, and the list of what
> a fresh clone is missing.

## What runs where

| Piece | Where | Address |
|---|---|---|
| SPA (`fe/dist`) + `/api` proxy | Caddy, native Windows process | `0.0.0.0:10000` |
| API (FastAPI) | container, Docker in WSL2 `Ubuntu-24.04` | `127.0.0.1:8000` |
| Postgres | container, same distro | `127.0.0.1:5432` |

The browser only ever talks to `:10000`. The SPA and `/api/*` share that one origin —
Caddy strips the `/api` prefix — so CORS is never exercised.

That is the whole deployment. There is no AI service in it any more: see
[No AI service](#no-ai-service) below.

## Two things that will surprise you

**1. `caddy reload` does not work.** [`Caddyfile`](Caddyfile) sets `admin off`, so applying
a change to it or to [`Caddyfile.site`](Caddyfile.site) means stopping the caddy process
and letting `start-itledger.ps1` (or the 5-minute watchdog) start it again.

`caddy.exe` itself is **vendored, not tracked** — it is a 53 MB copy of the binary the
retired `D:\LLM` stack used, gitignored at `deploy/caddy.exe`. A fresh checkout needs it
put back by hand before `:10000` will come up; the script logs a clear error if it is
missing.

**2. Compose must run inside WSL, never from Windows.** `DOCKER_HOST` on this host points
at a *different* Docker engine (Docker Desktop's, which this stack does not use). The API
also bind-mounts the repo, so the daemon has to see it as a Linux path:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash -lc `
  "cd /mnt/d/itledger/be && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d"
```

A WSL2 distro shuts down — taking dockerd and every container with it — the moment no
process is running inside it. `start-itledger.ps1` holds a `sleep infinity` open to prevent
that. It used to borrow the one `D:\LLM\start-llm.ps1` owned; it owns its own now.

## No AI service

Ask AI, the LLM reranker and the OCR file-extraction path were all removed when the `D:\LLM`
stack was retired — it was pinning ~6 GB of RAM and 88% of the GPU's VRAM to serve one
button. What that means here:

- Nothing in this deployment calls `192.168.3.252:8443` any more.
- The **e5-small embedder on `:8010` is no longer started.** It only ever served
  `/devices/semantic-search` and its two siblings, and nothing but Ask AI called those.
  `ai/run-host.ps1` and `fetch-model.ps1` are still in the repo if that changes.
- Handover import still works, from **Excel files matching the company template** —
  `be/handover_sheet.py` parses those in plain code, no model involved. PDFs, photos and
  off-template spreadsheets are refused with a clear message instead of hanging on a
  service that is not there.
- The switch is `AI_ENABLED` in `be/.env` (default off). Setting it to `1`, restoring the
  `LLM_*` variables and bringing `D:\LLM` back up re-enables the extraction and rerank
  paths. The Ask AI **UI** is gone from the frontend and would need a revert.

## Files

| File | Purpose |
|---|---|
| `Caddyfile` | The caddy config: global options + an import of the site block |
| `Caddyfile.site` | The `:10000` site block — SPA plus the `/api` proxy |
| `caddy.exe` | Vendored Caddy binary. **Gitignored** — copy one in by hand on a fresh checkout |
| `start-itledger.ps1` | Idempotent starter — WSL keepalive, containers, Caddy |
| `register-task.ps1` | One-time registration of the `ITLedger-AutoStart` task |
| `fetch-model.ps1` | Downloads the embedder's model files. Unused while the embedder is off |
| `autostart.log` | What the task did on each run, plus a reachability line per run |
| `access.log` | Caddy access log for `:10000` |
| `caddy.{out,err}.log` | stdout/stderr of the caddy process |

## Autostart

`ITLedger-AutoStart` runs `start-itledger.ps1` on two triggers:

- **At logon** as `IT-SERVER\IT`. Registered with `-LogonOnly`, which needs neither an
  elevated shell nor a stored password — the trade is that after a reboot the stack waits
  for someone to log into the IT account.
- **Every 5 minutes** as a watchdog. The script is idempotent, so a run is a no-op when
  things are healthy and a repair when they aren't.

Register it once:

```powershell
powershell -ExecutionPolicy Bypass -File D:\itledger\deploy\register-task.ps1 -LogonOnly
```

To make it come up unattended at boot instead, run `register-task.ps1` **elevated** and
without `-LogonOnly`; it will ask for the `IT` account's password to store. That fails if
the account lacks the **"Log on as a batch job"** right (`SeBatchLogonRight`) — grant it in
`secpol.msc` → Local Policies → User Rights Assignment.

## Python 3.12 is vendored

MSI installs are blocked by system policy on this server — the python.org installer exits
**1625** (`ERROR_INSTALL_PACKAGE_REJECTED`) and there is no `winget`. So the portable
[NuGet CPython build](https://www.nuget.org/packages/python) is unpacked to `.python312\`
(gitignored) and `ai/run-host.ps1` builds `ai/.venv` from it. Override with
`$env:ITLEDGER_PYTHON` if you install a real interpreter later. Only the embedder needs
this, so it is dormant while the embedder is off.

## After changing things

| Changed | Do this |
|---|---|
| Frontend code | `cd fe && npm run build` — Caddy serves `dist/` directly, no restart |
| Backend code | `wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /mnt/d/itledger/be && docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api"` |
| `Caddyfile` / `Caddyfile.site` | Stop and restart caddy (no `reload` — see above) |
| `be/sql/schema.sql` | Only runs on a fresh volume: `docker compose ... down -v && ... up -d` |

## Health checks

```powershell
curl http://127.0.0.1:8000/healthz        # {"status":"ok","db":"up"} - real DB round-trip
curl http://127.0.0.1:10000/api/health    # {"status":"ok"} - proves /api prefix stripping
Get-Content deploy\autostart.log -Tail 10
```
