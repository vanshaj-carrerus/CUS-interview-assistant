#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Loads Tauri updater signing key into the environment and runs `tauri build`.

.DESCRIPTION
  Uses TAURI_SIGNING_PRIVATE_KEY (file contents) + optional TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
  Key file: %USERPROFILE%\.tauri\myapp.key by default, or set TAURI_PRIVATE_KEY_FILE.

.EXAMPLE
  npm run tauri:build:signed

.EXAMPLE
  $env:TAURI_PRIVATE_KEY_FILE = "D:\secrets\myapp.key"
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-key-password"
  npm run tauri:build:signed

.EXAMPLE
  pwsh -File scripts/tauri-build-signed.ps1 -- --target x86_64-pc-windows-msvc
#>
$ErrorActionPreference = "Stop"

$keyPath = $env:TAURI_PRIVATE_KEY_FILE
if (-not $keyPath) {
  $keyPath = Join-Path $env:USERPROFILE ".tauri\myapp.key"
}

if (-not (Test-Path -LiteralPath $keyPath)) {
  Write-Host ""
  Write-Host "Private key not found at: $keyPath" -ForegroundColor Red
  Write-Host ""
  Write-Host "Fix one of:" -ForegroundColor Yellow
  Write-Host "  1. Copy your myapp.key to: $($env:USERPROFILE)\.tauri\myapp.key"
  Write-Host "  2. Or set TAURI_PRIVATE_KEY_FILE to the full path of myapp.key"
  Write-Host ""
  Write-Host "Generate a new pair (if you don't have one yet):" -ForegroundColor Yellow
  Write-Host "  npm run tauri -- signer generate -w `"$($env:USERPROFILE)\.tauri\myapp.key`""
  Write-Host "  Then put the printed public key into src-tauri/tauri.conf.json (plugins.updater.pubkey)"
  Write-Host "  and the same private key content into GitHub secret TAURI_SIGNING_PRIVATE_KEY."
  Write-Host ""
  exit 1
}

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $keyPath -Raw
if (-not $env:TAURI_SIGNING_PRIVATE_KEY.Trim()) {
  Write-Error "Key file is empty: $keyPath"
  exit 1
}

# Password optional (set in this shell if your key is encrypted):
#   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "Signing with key: $keyPath" -ForegroundColor Cyan
Write-Host "Using production build (remote API, no embedded secrets)." -ForegroundColor Cyan
if ($args.Count -gt 0) {
  & npm run tauri:build:production -- @args
} else {
  & npm run tauri:build:production
}
exit $LASTEXITCODE
