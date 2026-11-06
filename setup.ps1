# RetailCore — one-command local trial on Windows (PowerShell). Requires Docker Desktop running.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Host "Docker Desktop is not installed: https://www.docker.com/products/docker-desktop/" -ForegroundColor Red; exit 1 }
function New-Secret { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ }) }
if (-not (Test-Path .env)) {
  @"
POSTGRES_PASSWORD=postgres
JWT_SECRET=$(New-Secret)
MFA_ENCRYPTION_KEY=$(New-Secret)
CORS_ORIGINS=http://localhost:3000,http://localhost:1420
"@ | Set-Content -Encoding ascii .env
  Write-Host "Created .env with random secrets"
}
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "Waiting for the API..."
for ($i = 0; $i -lt 60; $i++) { try { Invoke-RestMethod http://localhost:4000/ready | Out-Null; break } catch { Start-Sleep 3 } }
$hasDemo = docker compose exec -T postgres psql -U postgres -d retailcore -tAc "select count(*) from core_user where email='demo@retailcore.app'"
if ($hasDemo.Trim() -eq "0") { docker compose run --rm seed }
Write-Host ""
Write-Host "Back-office: http://localhost:3000   (demo@retailcore.app / DemoPassw0rd!2026)" -ForegroundColor Green
Write-Host "POS:         http://localhost:1420   (create a device in Settings > Devices)" -ForegroundColor Green
Start-Process http://localhost:3000
