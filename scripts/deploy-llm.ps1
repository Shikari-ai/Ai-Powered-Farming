# Deploy Cloud Function agriLlmChat (GitHub Models) + Firebase Hosting.
#
# Prerequisites: Node 20+, Firebase CLI, Blaze plan for Cloud Functions + secrets.
#
#   $env:GITHUB_TOKEN = "<fine-grained PAT with models:read>"
#   .\scripts\deploy-llm.ps1

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

$key = $env:GITHUB_TOKEN
if (-not $key -or -not $key.Trim()) {
    Write-Host "Set GITHUB_TOKEN first (PAT with GitHub Models access)."
    Write-Host 'Example: $env:GITHUB_TOKEN = "github_pat_..."'
    exit 1
}

Write-Host "Setting secret GITHUB_TOKEN in Firebase (project from .firebaserc)..."
$key | firebase functions:secrets:set GITHUB_TOKEN --data-file - --force
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Installing Cloud Function dependencies..."
Push-Location (Join-Path $root "functions")
if (Test-Path "package-lock.json") {
    npm ci
} else {
    npm install
}
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "Deploying functions:agriLlmChat and hosting..."
firebase deploy --only functions:agriLlmChat,hosting
exit $LASTEXITCODE
