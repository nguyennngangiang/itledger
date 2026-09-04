# One-time: download the multilingual-e5-small ONNX model + tokenizer for the
# embedding service (ai/main.py). Files land in ai\.models\e5-small\ (gitignored).
# Idempotent — skips a file that is already present with a plausible size.
#
#   powershell -ExecutionPolicy Bypass -File deploy\fetch-model.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # progress bars make Invoke-WebRequest crawl

$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir   = Join-Path $repoRoot "ai\.models\e5-small"
$repo     = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main"

# name -> minimum plausible size, so a truncated/HTML error page is re-fetched
$files = @(
    @{ Url = "$repo/onnx/model.onnx"; Out = "model.onnx";     MinBytes = 100MB },
    @{ Url = "$repo/tokenizer.json";  Out = "tokenizer.json"; MinBytes = 1MB   }
)

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

foreach ($f in $files) {
    $dest = Join-Path $outDir $f.Out
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -ge $f.MinBytes)) {
        Write-Host "ok    $($f.Out) ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB) - skipping"
        continue
    }
    Write-Host "fetch $($f.Out) <- $($f.Url)"
    # Download to a temp name first so an interrupted run can't leave a partial
    # file that looks complete on the next pass.
    $tmp = "$dest.part"
    Invoke-WebRequest -Uri $f.Url -OutFile $tmp -UseBasicParsing -TimeoutSec 1800
    $len = (Get-Item $tmp).Length
    if ($len -lt $f.MinBytes) {
        Remove-Item $tmp -Force
        throw "$($f.Out) came back only $len bytes - expected at least $($f.MinBytes). Check network / HF availability."
    }
    Move-Item -Force $tmp $dest
    Write-Host "ok    $($f.Out) ($([math]::Round($len / 1MB, 1)) MB)"
}

Write-Host "`nModel ready in $outDir"
