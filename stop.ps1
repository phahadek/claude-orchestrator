# stop.ps1 — Stop backend and frontend dev servers
# Reads PIDs from .dashboard.pids; falls back to port-based detection if file is missing/stale

$BackendPort = 3000
$FrontendPort = 5173
$PidFile = Join-Path $PSScriptRoot ".dashboard.pids"

function Get-PortPid {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

function Stop-ProcessSafely {
    param([int]$Pid, [string]$Label)
    if ($Pid -le 0) { return }
    $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "[dashboard] Stopping $Label (PID $Pid)..." -ForegroundColor Yellow
        Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
        Write-Host "[dashboard] $Label stopped." -ForegroundColor Green
    } else {
        Write-Host "[dashboard] $Label PID $Pid not found (already stopped)." -ForegroundColor DarkGray
    }
}

function Stop-JobSafely {
    param([int]$JobId, [string]$Label)
    if ($JobId -le 0) { return }
    $job = Get-Job -Id $JobId -ErrorAction SilentlyContinue
    if ($job) {
        Write-Host "[dashboard] Removing background job for $Label (Job $JobId)..." -ForegroundColor Yellow
        Stop-Job -Id $JobId -ErrorAction SilentlyContinue
        Remove-Job -Id $JobId -Force -ErrorAction SilentlyContinue
    }
}

$usedPidFile = $false

if (Test-Path $PidFile) {
    try {
        $pids = Get-Content $PidFile -Raw | ConvertFrom-Json

        $bePid    = [int]$pids.BackendPid
        $fePid    = [int]$pids.FrontendPid
        $beJobId  = [int]$pids.BackendJobId
        $feJobId  = [int]$pids.FrontendJobId

        # Stop background jobs first (so npm doesn't restart child processes)
        Stop-JobSafely $beJobId "backend"
        Stop-JobSafely $feJobId "frontend"

        # Stop processes by PID
        Stop-ProcessSafely $bePid "backend"
        Stop-ProcessSafely $fePid "frontend"

        $usedPidFile = $true
    } catch {
        Write-Warning "Failed to parse PID file: $_"
    }
}

# Fallback: port-based detection for any surviving listeners
$bePidPort = Get-PortPid $BackendPort
$fePidPort = Get-PortPid $FrontendPort

if ($bePidPort) {
    Write-Host "[dashboard] Fallback: found process on port $BackendPort (PID $bePidPort)" -ForegroundColor Yellow
    Stop-ProcessSafely $bePidPort "backend (port fallback)"
}

if ($fePidPort) {
    Write-Host "[dashboard] Fallback: found process on port $FrontendPort (PID $fePidPort)" -ForegroundColor Yellow
    Stop-ProcessSafely $fePidPort "frontend (port fallback)"
}

if (-not $usedPidFile -and -not $bePidPort -and -not $fePidPort) {
    Write-Host "[dashboard] No running dashboard processes detected." -ForegroundColor DarkGray
}

# Clean up PID file
if (Test-Path $PidFile) {
    Remove-Item $PidFile -Force
    Write-Host "[dashboard] PID file removed." -ForegroundColor DarkGray
}

Write-Host "[dashboard] Done." -ForegroundColor Cyan
