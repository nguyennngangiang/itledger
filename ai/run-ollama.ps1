# Starts the local Ollama server on the host (headless, no standalone GUI),
# unless something is already serving on :11434. Used by `npm run dev` so the
# whole AI stack comes up alongside Vite.

$alreadyUp = $false
try {
    Invoke-WebRequest "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
    $alreadyUp = $true
} catch {
    $alreadyUp = $false
}

if ($alreadyUp) {
    Write-Host "Ollama already serving on :11434 - reusing it."
    # Keep this task alive so concurrently does not consider it finished.
    while ($true) { Start-Sleep -Seconds 3600 }
} else {
    Write-Host "Starting 'ollama serve' on :11434 (headless)..."
    & ollama serve
}
