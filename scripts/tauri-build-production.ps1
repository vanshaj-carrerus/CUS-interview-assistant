#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Build a production desktop installer that talks to your hosted API only (no embedded secrets).

.DESCRIPTION
  Uses https://www.custech.co by default. Optional src-tauri/.env overrides VITE_API_URL.
  Strips client-side AI keys from the build environment.
  Sets CUS_REMOTE_API=1 so the embedded MongoDB/API is not compiled in.

.EXAMPLE
  npm run tauri:build:production

.EXAMPLE
  npm run tauri:build:production -- -- --target x86_64-pc-windows-msvc
#>
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot "src-tauri\.env"
$defaultApiUrl = "https://www.custech.co"
$apiUrl = $defaultApiUrl

$envContent = $null
if (Test-Path -LiteralPath $envFile) {
  $envContent = Get-Content -LiteralPath $envFile -Raw
  if ($envContent -match '(?m)^\s*VITE_API_URL\s*=\s*(\S+)') {
    $apiUrl = $Matches[1].Trim().Trim('"').Trim("'")
  }
}
if ($apiUrl -match '^http://(127\.0\.0\.1|localhost)') {
  Write-Host ""
  Write-Host "Warning: VITE_API_URL points at localhost ($apiUrl)." -ForegroundColor Yellow
  Write-Host "For external users, use your public HTTPS API URL." -ForegroundColor Yellow
  Write-Host ""
}

$secretKeys = @(
  "VITE_GEMINI_API_KEY",
  "VITE_MISTRAL_API_KEY",
  "VITE_OPENROUTER_API_KEY",
  "MONGODB_URI",
  "JWT_SECRET",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY"
)
foreach ($key in $secretKeys) {
  Remove-Item "Env:$key" -ErrorAction SilentlyContinue
}

# Groq STT: prefer src-tauri/.env, then existing process env (e.g. CI secrets).
if ($envContent -and ($envContent -match '(?m)^\s*VITE_GROQ_API_KEY\s*=\s*(\S+)')) {
    $groqKey = $Matches[1].Trim().Trim('"').Trim("'")
    $env:VITE_GROQ_API_KEY = $groqKey
    $env:GROQ_API_KEY = $groqKey
}
if (-not $env:VITE_GROQ_API_KEY -and $env:GROQ_API_KEY) {
  $env:VITE_GROQ_API_KEY = $env:GROQ_API_KEY.Trim()
}
if (-not $env:VITE_GROQ_API_KEY) {
  Write-Host ""
  Write-Host "Warning: VITE_GROQ_API_KEY is not set. Speech-to-text will not work in this build." -ForegroundColor Yellow
  Write-Host "Add it to src-tauri/.env or set env before building (CI: GitHub secret GROQ_API_KEY)." -ForegroundColor Yellow
  Write-Host ""
}

$env:CUS_REMOTE_API = "1"
$env:VITE_API_URL = $apiUrl

Set-Location $repoRoot

Write-Host "Production build: remote API only ($apiUrl)" -ForegroundColor Cyan
Write-Host "Interview AI keys stay on server/.env; Groq STT key is embedded for transcription." -ForegroundColor Cyan

if ($args.Count -gt 0) {
  & npm run tauri -- build @args
} else {
  & npm run tauri -- build
}
exit $LASTEXITCODE
