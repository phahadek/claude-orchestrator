# start.ps1 - Launch backend and frontend dev servers as background jobs
# Saves PIDs to .dashboard.pids for use by stop.ps1 / restart.ps1

$BackendPort = 3000
$FrontendPort = 5173
$PidFile = Join-Path $PSScriptRoot ".dashboard.pids"

function Get-PortPid {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

# Check if already running
$bePid = Get-PortPid $BackendPort
$fePid = Get-PortPid $FrontendPort

if ($bePid -or $fePid) {
    if ($bePid) { Write-Warning "Backend already running on port $BackendPort (PID $bePid)" }
    if ($fePid) { Write-Warning "Frontend already running on port $FrontendPort (PID $fePid)" }
    Write-Error "Dashboard appears to be already running. Use restart.ps1 to restart, or stop.ps1 to stop it first."
    exit 1
}

$Root = $PSScriptRoot

# Start backend job
$beJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    npm run dev -w packages/backend 2>&1
} -ArgumentList $Root

# Start frontend job
$feJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    npm run dev -w packages/frontend 2>&1
} -ArgumentList $Root

Write-Host "[dashboard] Backend job ID: $($beJob.Id), Frontend job ID: $($feJob.Id)" -ForegroundColor Cyan

# Poll for port binding with a 30s upper bound (500ms interval)
$pollMaxMs = 30000
$pollIntervalMs = 500
$pollElapsed = 0
$bePidActual = $null
$fePidActual = $null
Write-Host "[dashboard] Waiting for ports to bind..." -ForegroundColor Cyan
while ($pollElapsed -lt $pollMaxMs) {
    if (-not $bePidActual) { $bePidActual = Get-PortPid $BackendPort }
    if (-not $fePidActual) { $fePidActual = Get-PortPid $FrontendPort }
    if ($bePidActual -and $fePidActual) { break }
    Start-Sleep -Milliseconds $pollIntervalMs
    $pollElapsed += $pollIntervalMs
}
if (-not $bePidActual) { Write-Warning "[dashboard] Backend port $BackendPort did not bind within ${pollMaxMs}ms" }
if (-not $fePidActual) { Write-Warning "[dashboard] Frontend port $FrontendPort did not bind within ${pollMaxMs}ms" }

# Save job IDs and PIDs to file
@{
    BackendJobId  = $beJob.Id
    FrontendJobId = $feJob.Id
    BackendPid    = $bePidActual
    FrontendPid   = $fePidActual
} | ConvertTo-Json | Set-Content -Path $PidFile

Write-Host "[dashboard] PID file written to $PidFile" -ForegroundColor Cyan
Write-Host "[dashboard] Streaming output (Ctrl+C to stop streaming - servers keep running)" -ForegroundColor Yellow
Write-Host ""

# Stream output with color-coded prefixes until interrupted
try {
    while ($true) {
        $beOutput = Receive-Job -Job $beJob -ErrorAction SilentlyContinue
        foreach ($line in $beOutput) {
            Write-Host "[BE] $line" -ForegroundColor Green
        }

        $feOutput = Receive-Job -Job $feJob -ErrorAction SilentlyContinue
        foreach ($line in $feOutput) {
            Write-Host "[FE] $line" -ForegroundColor Blue
        }

        # Check if jobs died unexpectedly
        if ($beJob.State -eq 'Failed') {
            Write-Host "[BE] Job failed." -ForegroundColor Red
            break
        }
        if ($feJob.State -eq 'Failed') {
            Write-Host "[FE] Job failed." -ForegroundColor Red
            break
        }

        Start-Sleep -Milliseconds 500
    }
}
catch [System.Management.Automation.PipelineStoppedException] {
    # User pressed Ctrl+C - this is expected; servers remain running as background jobs
    Write-Host ""
    Write-Host "[dashboard] Output streaming stopped. Servers continue running in the background." -ForegroundColor Yellow
    Write-Host "[dashboard] Run stop.ps1 (or npm run stop:win) to shut them down." -ForegroundColor Yellow
}
