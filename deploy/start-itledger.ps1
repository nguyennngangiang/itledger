<#
    start-itledger.ps1 — brings up the whole LAN deployment. Idempotent: safe to
    run any number of times, which is what lets the ITLedger-AutoStart task use it
    both as the AtStartup action and as a 5-minute watchdog.

    Pieces, and where each one lives:
      * Postgres + the FastAPI API   containers, Docker Engine inside the WSL2
                                     distro Ubuntu-24.04 (/mnt/d/itledger/be)
      * the e5-small embedder        native Windows process on :8010 (needs no
                                     container; ai/main.py picks CPU here)
      * Caddy on :10000              NOT ours — the caddy.exe that D:\LLM runs for
                                     the LLM stack also serves this app, via an
                                     import line in D:\LLM\caddy\Caddyfile

    Two things worth knowing before editing:
      1. A WSL2 distro shuts down — killing dockerd and every container with it —
         as soon as no process is running inside it. D:\LLM\start-llm.ps1 owns the
         `sleep infinity` keepalive that prevents that, so we call it rather than
         start a competing one.
      2. Caddy is shared. Delegating to start-llm.ps1 also means we don't have to
         duplicate its LLM_API_KEY loading: the :8443 block interpolates
         {$LLM_API_KEY}, and starting caddy without that variable set turns its
         Bearer matcher into a comparison against "Bearer ", which 401s every LLM
         request.
#>
$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$log      = Join-Path $PSScriptRoot 'autostart.log'
$distro   = 'Ubuntu-24.04'
$aiPort   = 8010

function Write-Log([string]$msg) {
    Add-Content -Path $log -Value "$((Get-Date).ToString('s'))  $msg"
}

function Test-Listening([int]$port) {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

Write-Log "--- start-itledger run (user=$env:USERNAME) ---"

# 1) Shared foundation: WSL keepalive + LLM containers + the caddy that serves us.
#    At boot LxssManager is often not ready the instant an AtStartup task fires, so
#    retry until the distro's docker daemon actually answers.
$llmStart = 'D:\LLM\start-llm.ps1'
$dockerVersion = $null
for ($i = 1; $i -le 10; $i++) {
    if (Test-Path $llmStart) {
        & $llmStart    # idempotent by design; its own guards skip work already done
    } elseif ($i -eq 1) {
        Write-Log "WARNING: $llmStart is missing - the WSL keepalive and Caddy (:10000) will NOT start"
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

# 3) Embedder. Guard on the port AND on an existing ai.main:app process. The port
#    alone is not enough: the service spends its first seconds compiling the 448MB
#    ONNX graph before it binds, so a tick landing inside that window would start a
#    second copy. Matching on the command line (not just Name='python.exe', which
#    other things on this host also use) closes that gap.
#    Note one embedder shows up as TWO processes: .venv\Scripts\python.exe is a
#    launcher stub that re-execs the real interpreter. That's normal, not a duplicate.
$embedderProc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*ai.main:app*' }

if (Test-Listening $aiPort) {
    Write-Log "embedder already listening on :$aiPort"
} elseif ($embedderProc) {
    Write-Log "embedder starting up (pid $($embedderProc.ProcessId -join ',')) - not bound yet, leaving it alone"
} else {
    $runHost = Join-Path $repoRoot 'ai\run-host.ps1'
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runHost`"" `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $PSScriptRoot 'embedder.out.log') `
        -RedirectStandardError  (Join-Path $PSScriptRoot 'embedder.err.log')
    Write-Log "started embedder (:$aiPort)"
}

# 4) Report what is actually reachable, so the log alone explains a bad boot.
$status = @(
    "caddy:10000=$(if (Test-Listening 10000) {'up'} else {'DOWN'})"
    "llm-caddy:8443=$(if (Test-Listening 8443) {'up'} else {'DOWN'})"
    "api:8000=$(if (Test-Listening 8000) {'up'} else {'DOWN'})"
    "embedder:$aiPort=$(if (Test-Listening $aiPort) {'up'} else {'starting'})"
) -join '  '
Write-Log "status  $status"
