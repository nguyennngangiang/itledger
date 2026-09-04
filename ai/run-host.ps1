# Launches the local embedding service on the Windows host (it stays out of Docker
# so it can use an Intel NPU where one exists; on a host without one OpenVINO falls
# back to CPU by itself — see ai/main.py).
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File ai\run-host.ps1
$ErrorActionPreference = "Stop"

$aiDir    = $PSScriptRoot
$repoRoot = Split-Path -Parent $aiDir
$py       = Join-Path $aiDir ".venv\Scripts\python.exe"

# Port 8001 is taken on the deployment host by the LLM stack's rag container, so
# default to 8010. Must match AI_URL in be/docker-compose.prod.yml.
if (-not $env:AI_PORT) { $env:AI_PORT = "8010" }

if (-not (Test-Path $py)) {
    # Find a Python 3.12 to build the venv from. MSI installs are blocked by system
    # policy on the deployment server (installer exits 1625), so the repo vendors
    # the portable NuGet build at .python312\ — see deploy/README.md.
    $candidates = @(
        $env:ITLEDGER_PYTHON,
        (Join-Path $repoRoot ".python312\tools\python.exe"),
        "$env:LocalAppData\Programs\Python\Python312\python.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }

    if (-not $candidates) {
        throw @"
No Python 3.12 found. Tried, in order:
  `$env:ITLEDGER_PYTHON
  $repoRoot\.python312\tools\python.exe
  $env:LocalAppData\Programs\Python\Python312\python.exe
Fix by either installing Python 3.12 (winget install -e --id Python.Python.3.12) or
unpacking the portable NuGet build to $repoRoot\.python312\ (nuget.org/packages/python).
"@
    }

    $base = $candidates[0]
    Write-Host "Creating venv with $base ..."
    & $base -m venv (Join-Path $aiDir ".venv")
    & $py -m pip install --upgrade pip
    & $py -m pip install -r (Join-Path $aiDir "requirements-host.txt")
}

# Model files (multilingual-e5-small ONNX + tokenizer) live in ai\.models\e5-small.
# Fetch them with deploy\fetch-model.ps1 if missing.
$env:MODEL_DIR     = Join-Path $aiDir ".models\e5-small"
$env:EMBED_DEVICES = "NPU,GPU,CPU"   # first device that can run the model wins

Set-Location $repoRoot
Write-Host "Starting embedding service on http://0.0.0.0:$($env:AI_PORT) (devices: $env:EMBED_DEVICES)"
& $py -m uvicorn ai.main:app --host 0.0.0.0 --port $env:AI_PORT
