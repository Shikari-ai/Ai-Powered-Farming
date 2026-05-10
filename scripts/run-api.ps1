# Run the FastAPI backend (LLM chat + vision). Secrets live in server/.env only (never commit).
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$server = Join-Path $root "server"
Set-Location $server

if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
    }
    Write-Host "Created server/.env — add GITHUB_TOKEN for chat (GitHub Models)."
}

$pythonExe = $null
foreach ($name in @("python", "py")) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) {
        $pythonExe = $c.Path
        break
    }
}
if (-not $pythonExe) {
    Write-Host "Install Python 3 and ensure 'python' or 'py' is on PATH."
    exit 1
}

Write-Host "Installing deps if needed..."
& $pythonExe -m pip install -q -r requirements.txt

Write-Host "Starting API on http://127.0.0.1:8000 (Ctrl+C to stop)"
& $pythonExe -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
