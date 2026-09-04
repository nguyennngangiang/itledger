<#
    start-itledger.ps1 — brings up the whole LAN deployment. Idempotent: safe to
    run any number of times, which is what lets the ITLedger-AutoStart task use it
    both as the AtLogon action and as a 5-minute watchdog.

    Pieces, and where each one lives:
      * WSL keepalive               a `sleep infinity` inside Ubuntu-24.04, held
                                    open so the distro (and its docker daemon)
                                    does not shut down
      * Postgres + the FastAPI API  containers, Docker Engine inside that same
                                    distro (/mnt/d/itledger/be)
      * Caddy on :10000             deploy\caddy.exe with deploy\Caddyfile

    Two things worth knowing before editing:
      1. A WSL2 distro shuts down — killing dockerd and every container with it —
         as soon as no process is running inside it. Step 1 below owns the
         keepalive that prevents that.
      2. This used to delegate steps 1 and 3 to D:\LLM\start-llm.ps1, because that
         stack's caddy.exe served :10000 for us via an import line and its
         keepalive held the distro up. The LLM stack is retired; nothing here
         touches D:\LLM any more, and neither the keepalive nor Caddy is shared.

    The e5-small embedder on :8010 is also gone. It only ever served
    /devices/semantic-search and its two siblings, which nothing but Ask AI
    called — and Ask AI was removed with the LLM stack. ai\run-host.ps1 is still
    in the repo if that changes.
#>
$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$log      = Join-Path $PSScriptRoot 'autostart.log'
$distro   = 'Ubuntu-24.04'
$caddyExe = Join-Path $PSScriptRoot 'caddy.exe'
$caddyCfg = Join-Path $PSScriptRoot 'Caddyfile'

function Write-Log([string]$msg) {
    Add-Content -Path $log -Value "$((Get-Date).ToString('s'))  $msg"
}

function Test-Listening([int]$port) {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

Write-Log "--- start-itledger run (user=$env:USERNAME) ---"

# 1) WSL keepalive + wait for the distro's docker daemon.
#    At boot LxssManager is often not ready the instant the task fires, so retry
#    until docker actually answers rather than assuming one launch was enough.
$dockerVersion = $null
for ($i = 1; $i -le 10; $i++) {
    $alive = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*sleep infinity*' }
    if (-not $alive) {
        Start-Process wsl.exe -ArgumentList "-d $distro -u root -- sleep infinity" -WindowStyle Hidden
        Write-Log "started WSL keepalive"
        Start-Sleep -Seconds 4
    }

    $dockerVersion = wsl.exe -d $distro -u root -- bash -lc 'docker info --format "{{.ServerVersion}}" 2>/dev/null'
    if ($dockerVersion) { break }

    Write-Log "WSL/docker not ready (attempt $i/10); waiting 15s"
    Start-Sleep -Seconds 15
}

if (-not $dockerVersion) {
    Write-Log "ERROR: docker in $distro never came up - aborting, the watchdog will retry"
    exit 1
}
Write-Log "foundation ready (docker $dockerVersion in $distro)"

# 2) itledger containers. Must run INSIDE the distro: the Windows DOCKER_HOST points
#    at a different engine, and the api service bind-mounts the repo, so the daemon
#    has to see it as a Linux path (/mnt/d/itledger).
$composeCmd = 'cd /mnt/d/itledger/be && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d'
$composeOut = wsl.exe -d $distro -u root -- bash -lc $composeCmd 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Log "compose up -d ok"
} else {
    Write-Log "compose up -d FAILED (exit $LASTEXITCODE): $($composeOut -join ' | ')"
}

# 3) Caddy :10000 — the SPA plus the /api proxy that puts the loopback-published
#    API container on the office LAN.
#    Matched on the command line, not `Get-Process caddy`: a caddy.exe belonging to
#    something else (the LLM stack used to be exactly that) would otherwise look
#    like ours and this would skip starting the one that serves :10000.
$caddyProc = Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$caddyCfg*" }

if ($caddyProc) {
    Write-Log "caddy already running (pid $($caddyProc.ProcessId -join ','))"
} elseif (-not (Test-Path $caddyExe)) {
    Write-Log "ERROR: $caddyExe is missing - :10000 will NOT come up"
} else {
    Start-Process -FilePath $caddyExe `
        -ArgumentList "run --config `"$caddyCfg`"" `
        -RedirectStandardOutput (Join-Path $PSScriptRoot 'caddy.out.log') `
        -RedirectStandardError  (Join-Path $PSScriptRoot 'caddy.err.log') `
        -WindowStyle Hidden
    Write-Log "launched caddy (:10000)"
    # Long enough to bind or to fail. Without the wait the status line below reports
    # on a process that has not decided yet.
    Start-Sleep -Seconds 3
}

# 4) Report what is actually reachable, so the log alone explains a bad boot.
#    Caddy is reported twice on purpose. The port alone answers "is something
#    serving :10000", which is not the same question as "is OUR caddy serving it" —
#    a second process holding the port makes ours exit on a bind error while the
#    port check still says `up`. Two fields make that visible instead of silent.
$ourCaddy = Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$caddyCfg*" }
$status = @(
    "caddy.proc=$(if ($ourCaddy) {'up'} else {'DOWN'})"
    "caddy:10000=$(if (Test-Listening 10000) {'up'} else {'DOWN'})"
    "api:8000=$(if (Test-Listening 8000) {'up'} else {'DOWN'})"
) -join '  '
Write-Log "status  $status"
if (-not $ourCaddy -and (Test-Listening 10000)) {
    Write-Log "WARNING: :10000 is held by a caddy that is not ours - check deploy\caddy.err.log"
}
