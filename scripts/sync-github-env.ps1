#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Download src-tauri/.env from GitHub Actions secrets (via dev-env-export workflow).

.DESCRIPTION
  Secret values cannot be read with `gh secret` locally. This script triggers
  .github/workflows/dev-env-export.yml, waits for the run, and writes the artifact to src-tauri/.env.

  Requires: GitHub CLI (`gh auth login`) with access to this repository.

.EXAMPLE
  npm run env:sync
  npm run env:sync -- -Force
#>
param([switch]$Force)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot "src-tauri\.env"

function Test-GroqKeyInEnv {
  if (-not (Test-Path -LiteralPath $envFile)) { return $false }
  $content = Get-Content -LiteralPath $envFile -Raw
  return $content -match '(?m)^\s*VITE_GROQ_API_KEY\s*=\s*\S+'
}

if (-not $Force -and (Test-GroqKeyInEnv)) {
  Write-Host "src-tauri/.env already has VITE_GROQ_API_KEY. Use -Force to refresh from GitHub." -ForegroundColor Green
  exit 0
}

$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCmd) {
  Write-Error "GitHub CLI (gh) is required. Install: winget install GitHub.cli"
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Run: gh auth login  (needs repo access to run workflows and download artifacts)"
}

Write-Host "Triggering dev-env-export workflow (uses repository secrets)..." -ForegroundColor Cyan
gh workflow run dev-env-export.yml
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to start workflow. Push .github/workflows/dev-env-export.yml to the default branch first."
}

Start-Sleep -Seconds 4

$runId = gh run list --workflow=dev-env-export.yml --limit 1 --json databaseId -q ".[0].databaseId"
if (-not $runId) {
  Write-Error "Could not find workflow run. Check the Actions tab on GitHub."
}

Write-Host "Waiting for run $runId ..." -ForegroundColor Cyan
gh run watch $runId --exit-status
if ($LASTEXITCODE -ne 0) {
  Write-Error "Workflow failed. Open GitHub Actions → Dev env export for logs."
}

$tmpdir = Join-Path ([IO.Path]::GetTempPath()) ("cus-dev-env-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmpdir | Out-Null

try {
  gh run download $runId --dir $tmpdir --name dev-env
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to download dev-env artifact."
  }

  $downloaded = Get-ChildItem -Path $tmpdir -Recurse -Filter "dev.env" |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $downloaded) {
    Write-Error "dev.env not found in artifact."
  }

  $localApiUrl = $null
  if (Test-Path -LiteralPath $envFile) {
    $old = Get-Content -LiteralPath $envFile -Raw
    if ($old -match '(?m)^\s*VITE_API_URL\s*=\s*(\S+)') {
      $localApiUrl = $Matches[1].Trim().Trim('"').Trim("'")
    }
  }

  $newContent = (Get-Content -LiteralPath $downloaded -Raw).TrimEnd()
  if ($localApiUrl) {
    $newContent = [regex]::Replace(
      $newContent,
      '(?m)^\s*VITE_API_URL\s*=.*',
      "VITE_API_URL=$localApiUrl"
    )
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText($envFile, $newContent + "`n", $utf8NoBom)
  Write-Host "Wrote $envFile from GitHub Actions secrets." -ForegroundColor Green
} finally {
  Remove-Item -Path $tmpdir -Recurse -Force -ErrorAction SilentlyContinue
}
