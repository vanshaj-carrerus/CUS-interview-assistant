# Quick smoke test: health + register + login against CUS Tech production API.
# Usage: .\scripts\test-production-auth.ps1
# Optional: $env:TEST_EMAIL = "you@company.com"; $env:TEST_PASSWORD = "your-password"

$Base = if ($env:CUS_TECH_API_URL) { $env:CUS_TECH_API_URL.TrimEnd('/') } else { "https://www.custech.co" }
$rand = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$Email = if ($env:TEST_EMAIL) { $env:TEST_EMAIL } else { "cus-assistant-test-$rand@custech.co.test" }
$Password = if ($env:TEST_PASSWORD) { $env:TEST_PASSWORD } else { "TestPass123!" }

function Invoke-CusApi($Method, $Path, $Body, $Token) {
    $headers = @{ "Content-Type" = "application/json" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    $uri = "$Base$Path"
    $params = @{ Method = $Method; Uri = $uri; Headers = $headers }
    if ($Body) { $params["Body"] = ($Body | ConvertTo-Json -Compress) }
    try {
        $r = Invoke-RestMethod @params
        return @{ Ok = $true; Data = $r }
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        $msg = $_.ErrorDetails.Message
        return @{ Ok = $false; Status = $status; Error = $msg }
    }
}

Write-Host "API: $Base" -ForegroundColor Cyan

$h = Invoke-CusApi GET "/api/cus-assistant/health" $null $null
if (-not $h.Ok) { Write-Host "Health FAILED: $($h.Error)" -ForegroundColor Red; exit 1 }
Write-Host "Health OK: $($h.Data | ConvertTo-Json -Compress)" -ForegroundColor Green

$reg = Invoke-CusApi POST "/api/cus-assistant/auth/register" @{ email = $Email; password = $Password; name = "API Test" } $null
if (-not $reg.Ok) {
    Write-Host "Register skipped/failed ($($reg.Status)): $($reg.Error)" -ForegroundColor Yellow
    $loginOnly = $true
} else {
    Write-Host "Register OK - user id: $($reg.Data.user.id), aiAllowed: $($reg.Data.user.aiAllowed)" -ForegroundColor Green
    $loginOnly = $false
}

$login = Invoke-CusApi POST "/api/cus-assistant/auth/login" @{ email = $Email; password = $Password } $null
if (-not $login.Ok) { Write-Host "Login FAILED: $($login.Error)" -ForegroundColor Red; exit 1 }
$token = $login.Data.token
Write-Host "Login OK - aiAllowed: $($login.Data.user.aiAllowed)" -ForegroundColor Green

$me = Invoke-CusApi GET "/api/cus-assistant/auth/me" $null $token
if (-not $me.Ok) { Write-Host "/me FAILED: $($me.Error)" -ForegroundColor Red; exit 1 }
Write-Host "Me OK: $($me.Data.user.email), aiAllowed=$($me.Data.user.aiAllowed)" -ForegroundColor Green

Write-Host "`nTo enable AI for this user (requires INTERVIEW_ADMIN_SECRET on CUS Tech):" -ForegroundColor Cyan
Write-Host "  cd ..\CUS_TECH" -ForegroundColor Gray
Write-Host "  `$env:INTERVIEW_ADMIN_SECRET='your-secret'; node scripts/enable-interview-ai.mjs --email $Email" -ForegroundColor Gray
