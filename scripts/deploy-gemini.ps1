# Deploy Cloud Function agriGeminiChat + Firebase Hosting so the assistant uses Gemini.
#
# Prerequisites: Node 20+, Firebase CLI (`npm i -g firebase-tools`), `firebase login` once.
# Firebase project must be on the Blaze plan (Secret Manager is not available on Spark-only).
#
# Usage (use a NEW key if the old one was ever pasted in chat or Git):
#   $env:GEMINI_API_KEY = "<your Google AI Studio API key>"
#   .\scripts\deploy-gemini.ps1

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

$key = $env:GEMINI_API_KEY
if (-not $key -or -not $key.Trim()) {
    Write-Host "Set GEMINI_API_KEY first (your rotated Google AI key)."
    Write-Host 'Example: $env:GEMINI_API_KEY = "..."'
    exit 1
}

Write-Host "Setting secret GEMINI_API_KEY in Firebase (project from .firebaserc)..."
$key | firebase functions:secrets:set GEMINI_API_KEY --data-file - --force
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

Write-Host "Deploying functions:agriGeminiChat and hosting..."
firebase deploy --only functions:agriGeminiChat,hosting
exit $LASTEXITCODE
