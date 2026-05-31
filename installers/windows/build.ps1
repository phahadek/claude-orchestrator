<#
.SYNOPSIS
  Builds the Claude Orchestrator Windows installer (.exe).

.DESCRIPTION
  1. Downloads Node 20 LTS Windows x64 from nodejs.org and verifies its SHA-256.
  2. Runs `npm run build` to compile frontend + backend (skippable with -SkipBuild).
  3. Assembles the installer payload under installers/windows/payload/.
  4. Invokes Inno Setup to produce installers/windows/dist/claude-orchestrator-setup.exe.

.PARAMETER InnoSetupPath
  Path to ISCC.exe. Defaults to the standard Inno Setup 6 install location.

.PARAMETER SkipBuild
  Skip the npm build step when dist/ is already up to date.

.PARAMETER NodeVersion
  Node 20 LTS patch version to bundle. Defaults to 20.19.2.
#>
param(
  [string]$InnoSetupPath = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  [switch]$SkipBuild,
  [string]$NodeVersion = "20.19.2"
)

$ErrorActionPreference = "Stop"

$ScriptDir  = $PSScriptRoot
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$PayloadDir = Join-Path $ScriptDir "payload"
$DistDir    = Join-Path $ScriptDir "dist"

$NodeFilename = "node-v$NodeVersion-win-x64"
$NodeZipName  = "$NodeFilename.zip"
$NodeZipPath  = Join-Path $env:TEMP $NodeZipName
$NodeExtracted = Join-Path $env:TEMP $NodeFilename

$NodeZipUrl   = "https://nodejs.org/dist/v$NodeVersion/$NodeZipName"
$ShasumUrl    = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"

# ── 1. Download Node ──────────────────────────────────────────────────────────
Write-Host "==> Downloading Node $NodeVersion..."
if (-not (Test-Path $NodeZipPath)) {
  Invoke-WebRequest -Uri $NodeZipUrl -OutFile $NodeZipPath -UseBasicParsing
} else {
  Write-Host "    (cached at $NodeZipPath)"
}

# ── 2. Verify checksum ────────────────────────────────────────────────────────
Write-Host "==> Verifying SHA-256..."
$ShasumContent = (Invoke-WebRequest -Uri $ShasumUrl -UseBasicParsing).Content
$ExpectedLine  = ($ShasumContent -split "`n") | Where-Object { $_ -match [regex]::Escape($NodeZipName) }
if (-not $ExpectedLine) {
  throw "No checksum entry found for '$NodeZipName' in SHASUMS256.txt"
}
$ExpectedHash = ($ExpectedLine.Trim() -split '\s+')[0]
$ActualHash   = (Get-FileHash -Algorithm SHA256 -Path $NodeZipPath).Hash
if ($ActualHash.ToLower() -ne $ExpectedHash.ToLower()) {
  throw "Checksum mismatch!`n  Expected : $ExpectedHash`n  Got      : $ActualHash"
}
Write-Host "    OK: $ActualHash"

# ── 3. Extract Node ───────────────────────────────────────────────────────────
Write-Host "==> Extracting Node to $NodeExtracted..."
if (Test-Path $NodeExtracted) { Remove-Item $NodeExtracted -Recurse -Force }
Expand-Archive -Path $NodeZipPath -DestinationPath $env:TEMP

# ── 4. Build frontend + backend ───────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Host "==> Building frontend and backend..."
  Push-Location $RepoRoot
  try {
    & npm ci --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  } finally {
    Pop-Location
  }
}

# ── 5. Assemble payload ───────────────────────────────────────────────────────
Write-Host "==> Assembling payload..."
if (Test-Path $PayloadDir) { Remove-Item $PayloadDir -Recurse -Force }
New-Item -ItemType Directory -Path $PayloadDir | Out-Null

# node.exe
Copy-Item (Join-Path $NodeExtracted "node.exe") (Join-Path $PayloadDir "node.exe")

# start.bat
Copy-Item (Join-Path $ScriptDir "start.bat") (Join-Path $PayloadDir "start.bat")

# app/ directory
$AppDir = Join-Path $PayloadDir "app"
New-Item -ItemType Directory -Path $AppDir | Out-Null

# Backend dist/
$BackendDist = Join-Path $RepoRoot "packages\backend\dist"
Get-ChildItem -Path $BackendDist | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination $AppDir -Recurse -Force
}

# Frontend dist/ → app/public/
$FrontendDist = Join-Path $RepoRoot "packages\frontend\dist"
$PublicDir = Join-Path $AppDir "public"
New-Item -ItemType Directory -Path $PublicDir | Out-Null
Get-ChildItem -Path $FrontendDist | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination $PublicDir -Recurse -Force
}

# ── 6. Install production node_modules ────────────────────────────────────────
Write-Host "==> Installing production node_modules..."
# Copy backend package.json so npm knows what to install
Copy-Item (Join-Path $RepoRoot "packages\backend\package.json") (Join-Path $AppDir "package.json")

# Use bundled node + bundled npm for version-correct native module prebuild downloads
$BundledNode = Join-Path $PayloadDir "node.exe"
$BundledNpm  = Join-Path $NodeExtracted "node_modules\npm\bin\npm-cli.js"

$env:npm_config_target   = $NodeVersion
$env:npm_config_arch     = "x64"
$env:npm_config_platform = "win32"

Push-Location $AppDir
try {
  & $BundledNode $BundledNpm install --omit=dev --ignore-scripts=false
  if ($LASTEXITCODE -ne 0) { throw "npm install failed in payload/app" }
} finally {
  Pop-Location
}

# Clean up env vars
Remove-Item Env:\npm_config_target   -ErrorAction SilentlyContinue
Remove-Item Env:\npm_config_arch     -ErrorAction SilentlyContinue
Remove-Item Env:\npm_config_platform -ErrorAction SilentlyContinue

# ── 7. Compile installer ──────────────────────────────────────────────────────
Write-Host "==> Compiling installer..."
if (-not (Test-Path $InnoSetupPath)) {
  throw "Inno Setup not found at: $InnoSetupPath`nDownload from https://jrsoftware.org/isinfo.php"
}
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir | Out-Null }

& $InnoSetupPath (Join-Path $ScriptDir "setup.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed (exit $LASTEXITCODE)" }

$InstallerPath = Join-Path $DistDir "claude-orchestrator-setup.exe"
$SizeMB = [math]::Round((Get-Item $InstallerPath).Length / 1MB, 1)
Write-Host ""
Write-Host "==> Done!"
Write-Host "    Output : $InstallerPath"
Write-Host "    Size   : $SizeMB MB"
if ($SizeMB -gt 48) {
  Write-Warning "Installer exceeds target size of 48 MB ($SizeMB MB)"
}
