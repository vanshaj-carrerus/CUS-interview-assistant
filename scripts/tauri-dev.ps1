#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Sync src-tauri/.env from GitHub secrets, then run `tauri dev`.
#>
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot "sync-github-env.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location $repoRoot
& npm run tauri -- dev @args
exit $LASTEXITCODE
