# restart.ps1 — Restart backend and/or frontend dev servers
# Usage:
#   .\restart.ps1              — restart both
#   .\restart.ps1 -backend    — restart backend only
#   .\restart.ps1 -frontend   — restart frontend only

param(
    [switch]$backend,
    [switch]$frontend
)

$BackendPort = 3000
$FrontendPort = 5173
$PidFile = Join-Path $PSScriptRoot ".dashboard.pids"
$Root = $PSScriptRoot

# If neither flag set, restart both
$restartBoth = -not $backend -and -not $frontend

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
    }
}

function Stop-JobSafely {
    param([int]$JobId, [string]$Label)
    if ($JobId -le 0) { return }
    $job = Get-Job -Id $JobId -ErrorAction SilentlyContinue
    if ($job) {
        Stop-Job -Id $JobId -ErrorAction SilentlyContinue
        Remove-Job -Id $JobId -Force -ErrorAction SilentlyContinue
    }
}

# Read current PID file if available
$currentPids = $null
if (Test-Path $PidFile) {
    try {
        $currentPids = Get-Content $PidFile -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "Could not parse PID file: $_"
    }
}

# --- Stop targeted services ---

if ($restartBoth -or $backend) {
    $bePid   = if ($currentPids) { [int]$currentPids.BackendPid } else { 0 }
    $beJobId = if ($currentPids) { [int]$currentPids.BackendJobId } else { 0 }
    Stop-JobSafely $beJobId "backend"
    Stop-ProcessSafely $bePid "backend"
    # Fallback port kill
    $beFallback = Get-PortPid $BackendPort
    if ($beFallback) { Stop-ProcessSafely $beFallback "backend (port fallback)" }
    Write-Host "[dashboard] Backend stopped." -ForegroundColor Green
}

if ($restartBoth -or $frontend) {
    $fePid   = if ($currentPids) { [int]$currentPids.FrontendPid } else { 0 }
    $feJobId = if ($currentPids) { [int]$currentPids.FrontendJobId } else { 0 }
    Stop-JobSafely $feJobId "frontend"
    Stop-ProcessSafely $fePid "frontend"
    # Fallback port kill
    $feFallback = Get-PortPid $FrontendPort
    if ($feFallback) { Stop-ProcessSafely $feFallback "frontend (port fallback)" }
    Write-Host "[dashboard] Frontend stopped." -ForegroundColor Green
}

Start-Sleep -Seconds 1

# --- Reload PID file for services we're NOT restarting ---
$newPids = @{
    BackendJobId  = 0
    FrontendJobId = 0
    BackendPid    = 0
    FrontendPid   = 0
}

if ($currentPids -and -not $restartBoth) {
    if (-not $backend) {
        $newPids.BackendJobId = [int]$currentPids.BackendJobId
        $newPids.BackendPid   = [int]$currentPids.BackendPid
    }
    if (-not $frontend) {
        $newPids.FrontendJobId = [int]$currentPids.FrontendJobId
        $newPids.FrontendPid   = [int]$currentPids.FrontendPid
    }
}

# --- Start targeted services ---

if ($restartBoth -or $backend) {
    Write-Host "[dashboard] Starting backend..." -ForegroundColor Cyan
    $beJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location $dir
        npm run dev -w packages/backend 2>&1
    } -ArgumentList $Root
    $newPids.BackendJobId = $beJob.Id
}

if ($restartBoth -or $frontend) {
    Write-Host "[dashboard] Starting frontend..." -ForegroundColor Cyan
    $feJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location $dir
        npm run dev -w packages/frontend 2>&1
    } -ArgumentList $Root
    $newPids.FrontendJobId = $feJob.Id
}

# Wait for ports to bind
Start-Sleep -Seconds 3

if ($restartBoth -or $backend) {
    $newPids.BackendPid = Get-PortPid $BackendPort
}
if ($restartBoth -or $frontend) {
    $newPids.FrontendPid = Get-PortPid $FrontendPort
}

# Write updated PID file
$newPids | ConvertTo-Json | Set-Content -Path $PidFile
Write-Host "[dashboard] PID file updated at $PidFile" -ForegroundColor DarkGray

Write-Host "[dashboard] Restart complete. Streaming output (Ctrl+C stops streaming, servers keep running)..." -ForegroundColor Yellow
Write-Host ""

# Stream output
$beJobToStream = if ($restartBoth -or $backend) { $beJob } else { Get-Job -Id $newPids.BackendJobId -ErrorAction SilentlyContinue }
$feJobToStream = if ($restartBoth -or $frontend) { $feJob } else { Get-Job -Id $newPids.FrontendJobId -ErrorAction SilentlyContinue }

try {
    while ($true) {
        if ($beJobToStream) {
            $beOutput = Receive-Job -Job $beJobToStream -ErrorAction SilentlyContinue
            foreach ($line in $beOutput) { Write-Host "[BE] $line" -ForegroundColor Green }
        }
        if ($feJobToStream) {
            $feOutput = Receive-Job -Job $feJobToStream -ErrorAction SilentlyContinue
            foreach ($line in $feOutput) { Write-Host "[FE] $line" -ForegroundColor Blue }
        }
        Start-Sleep -Milliseconds 500
    }
}
catch [System.Management.Automation.PipelineStoppedException] {
    Write-Host ""
    Write-Host "[dashboard] Output streaming stopped. Servers continue running in the background." -ForegroundColor Yellow
    Write-Host "[dashboard] Run stop.ps1 (or npm run stop:win) to shut them down." -ForegroundColor Yellow
}
