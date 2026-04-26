# restart-backend.ps1 — Kill port 3000 and restart the backend
# Usage: .\restart-backend.ps1
# Runs the backend in the foreground (Ctrl+C stops it).

$ErrorActionPreference = 'SilentlyContinue'
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force
    Write-Host "[backend] Stopped PID $($conn.OwningProcess)" -ForegroundColor Yellow
    Start-Sleep -Seconds 1
} else {
    Write-Host "[backend] Nothing running on port 3000" -ForegroundColor DarkGray
}

Write-Host "[backend] Starting..." -ForegroundColor Cyan
Set-Location $PSScriptRoot
npm run dev --prefix packages/backend
