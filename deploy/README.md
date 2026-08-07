# LAN deployment

Serves IT Ledger to the office network at **http://192.168.3.252:10000**, and brings
the whole stack back after a reboot with nobody logged in.

## What runs where

| Piece | Where | Address |
|---|---|---|
| SPA (`fe/dist`) + `/api` proxy | Caddy, native Windows process | `0.0.0.0:10000` |
| API (FastAPI) | container, Docker in WSL2 `Ubuntu-24.04` | `127.0.0.1:8000` |
| Postgres | container, same distro | `127.0.0.1:5432` |
| e5-small embedder (`ai/`) | native Windows process | `0.0.0.0:8010` |
| LLM (chat, rerank, extract) | **pre-existing** `D:\LLM` stack | `192.168.3.252:8443` |

The browser only ever talks to `:10000`. The SPA and `/api/*` share that one origin —
Caddy strips the `/api` prefix — so CORS is never exercised.

## Three things that will surprise you

**1. There is no Caddy process of our own.** The `caddy.exe` that `D:\LLM` runs for the
LLM stack serves this app too. The only change outside this repo is one line appended to
`D:\LLM\caddy\Caddyfile`:

```
import "D:/itledger/deploy/Caddyfile.site"
```

The site block itself lives here, in [`Caddyfile.site`](Caddyfile.site), version-controlled
with the app. Consequence: that Caddyfile sets `admin off`, so **`caddy reload` does not
work** — applying a change to `Caddyfile.site` means stopping and restarting the caddy
process, which briefly interrupts `:8443` as well.

**2. Compose must run inside WSL, never from Windows.** `DOCKER_HOST` on this host points
at a *different* Docker engine than the one the LLM stack (and this app) use. The API also
bind-mounts the repo, so the daemon has to see it as a Linux path:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash -lc `
  "cd /mnt/d/itledger/be && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d"
```

**3. Ports 8001 and 8443 are already taken** by the LLM stack's `llm-rag` container and its
Caddy front. That is why the embedder listens on **8010**, not the 8001 you will see in
older docs.

## Files

| File | Purpose |
|---|---|
| `Caddyfile.site` | The `:10000` site block, imported by `D:\LLM\caddy\Caddyfile` |
| `start-itledger.ps1` | Idempotent starter — containers, embedder, and (via `D:\LLM\start-llm.ps1`) the WSL keepalive and Caddy |
| `register-task.ps1` | One-time registration of the `ITLedger-AutoStart` task. **Run elevated.** |
| `fetch-model.ps1` | Downloads `model.onnx` + `tokenizer.json` into `ai/.models/e5-small/` |
| `autostart.log` | What the task did on each run, plus a reachability line per run |
| `access.log` | Caddy access log for `:10000` |
| `embedder.{out,err}.log` | stdout/stderr of the embedder process |

## Autostart

`ITLedger-AutoStart` runs `start-itledger.ps1` on two triggers:

- **AtStartup**, as `IT-SERVER\IT` with a *stored password*. The stored password is what
  makes it work with nobody logged in — without one Windows can only run the task in an
  interactive session.
- **Every 5 minutes** as a watchdog. The script is idempotent, so a run is a no-op when
  things are healthy and a repair when they aren't.

Register it once, from an **elevated** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File D:\itledger\deploy\register-task.ps1
```

If that fails with a logon failure, the account lacks the **"Log on as a batch job"** right
(`SeBatchLogonRight`) — grant it in `secpol.msc` → Local Policies → User Rights Assignment.

Side effect worth knowing: `LLM-AutoStart` only triggers at *logon*, so before this task
existed the LLM stack also needed someone to log in after a reboot. Because
`start-itledger.ps1` calls `D:\LLM\start-llm.ps1` at startup, the LLM stack now comes back
unattended too.

## Python 3.12 is vendored

MSI installs are blocked by system policy on this server — the python.org installer exits
**1625** (`ERROR_INSTALL_PACKAGE_REJECTED`) and there is no `winget`. So the portable
[NuGet CPython build](https://www.nuget.org/packages/python) is unpacked to `.python312\`
(gitignored) and `ai/run-host.ps1` builds `ai/.venv` from it. Override with
`$env:ITLEDGER_PYTHON` if you install a real interpreter later.

This host has **no Intel NPU** — `openvino` reports `['CPU']` (the GPU is an NVIDIA
RTX 5060, which OpenVINO cannot target). `ai/main.py` walks `EMBED_DEVICES` and skips
absent devices, so it lands on CPU with no configuration. Fine for e5-small.

## After changing things

| Changed | Do this |
|---|---|
| Frontend code | `cd fe && npm run build` — Caddy serves `dist/` directly, no restart |
| Backend code | `wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /mnt/d/itledger/be && docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api"` |
| `Caddyfile.site` | Stop and restart caddy (no `reload` — see above) |
| `be/sql/schema.sql` | Only runs on a fresh volume: `docker compose ... down -v && ... up -d` |

## Health checks

```powershell
curl http://127.0.0.1:8000/healthz        # {"status":"ok","db":"up"} - real DB round-trip
curl http://127.0.0.1:8010/health         # ready:true, device:"CPU"
curl http://127.0.0.1:10000/api/health    # {"status":"ok"} - proves /api prefix stripping
Get-Content deploy\autostart.log -Tail 10
```
