# Launches the local NPU/GPU-accelerated embedding service on the Windows host.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File ai\run-host.ps1
$ErrorActionPreference = "Stop"

$aiDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $aiDir
$py       = Join-Path $aiDir ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Host "Creating venv with Python 3.12..."
    $p312 = "$env:LocalAppData\Programs\Python\Python312\python.exe"
    if (-not (Test-Path $p312)) { throw "Python 3.12 not found. Install: winget install -e --id Python.Python.3.12" }
    & $p312 -m venv (Join-Path $aiDir ".venv")
    & $py -m pip install --upgrade pip
    & $py -m pip install -r (Join-Path $aiDir "requirements-host.txt")
}

# Model files (bge-small-en-v1.5 ONNX + tokenizer) live in ai\.models.
$env:MODEL_DIR     = Join-Path $aiDir ".models"
$env:EMBED_DEVICES = "NPU,GPU,CPU"   # first device that can run the model wins

Set-Location $repoRoot
Write-Host "Starting embedding service on http://localhost:8001 (devices: $env:EMBED_DEVICES)"
& $py -m uvicorn ai.main:app --host 0.0.0.0 --port 8001
