[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

function Invoke-Step([string]$Name, [scriptblock]$Action) {
  Write-Output "[$Name]"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

Invoke-Step 'install-lockfile' { npm install --ignore-scripts }
Invoke-Step 'production-audit' { npm audit --omit=dev --audit-level=high }
Invoke-Step 'tests' { npm test }
Invoke-Step 'model-integrity' { npm run fetch-models -- --with-brain }
Invoke-Step 'installer' { npm run dist }

$installer = Join-Path $repo 'dist-package\Jarvis Setup 0.1.0.exe'
if (-not (Test-Path -LiteralPath $installer)) {
  throw "Installer was not produced: $installer"
}

# Run the exact packaged Electron layout against an isolated, brain-enabled profile. Models are
# read from the verified repository set, while all state/index writes stay under ignored scratch/.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$smokeRoot = Join-Path $repo "scratch\private-beta-release-$stamp"
$smokeProfile = Join-Path $smokeRoot 'profile'
$smokeVault = Join-Path $smokeRoot 'vault'
New-Item -ItemType Directory -Force -Path $smokeProfile,$smokeVault | Out-Null
$smokeConfig = @{
  secondBrain = @{
    enabled = $true
    vaultDir = $smokeVault
    autoCapture = $true
    recallMode = 'hybrid'
  }
} | ConvertTo-Json -Depth 4
# Windows PowerShell 5's `-Encoding utf8` emits a BOM; JSON.parse does not accept that prefix.
[System.IO.File]::WriteAllText(
  (Join-Path $smokeProfile 'config.json'),
  $smokeConfig,
  [System.Text.UTF8Encoding]::new($false)
)

$smokeStdout = Join-Path $smokeRoot 'stdout.log'
$smokeStderr = Join-Path $smokeRoot 'stderr.log'
$packagedExe = Join-Path $repo 'dist-package\win-unpacked\Jarvis.exe'
$oldUserData = $env:JARVIS_USER_DATA_DIR
$oldModels = $env:JARVIS_MODELS_DIR
$oldSmokeExit = $env:JARVIS_SMOKE_EXIT_MS
try {
  $env:JARVIS_USER_DATA_DIR = $smokeProfile
  $env:JARVIS_MODELS_DIR = (Join-Path $repo 'models')
  $env:JARVIS_SMOKE_EXIT_MS = '20000'
  # Deliberately launch visibly: this exercises WindowManager.showMain(), renderer HTML, and the
  # preload path in addition to background startup. A hidden-only smoke once missed an ESM
  # `__dirname` failure in this exact path.
  $smoke = Start-Process -FilePath $packagedExe -PassThru -Wait `
    -WindowStyle Hidden -RedirectStandardOutput $smokeStdout -RedirectStandardError $smokeStderr
} finally {
  $env:JARVIS_USER_DATA_DIR = $oldUserData
  $env:JARVIS_MODELS_DIR = $oldModels
  $env:JARVIS_SMOKE_EXIT_MS = $oldSmokeExit
}
if ($smoke.ExitCode -ne 0) {
  throw "Packaged startup smoke failed with exit code $($smoke.ExitCode)"
}
$smokeLog = Get-Content -LiteralPath $smokeStdout -Raw
$milestones = @(
  '[main] second brain enabled',
  '[main] brain embedder warmed up',
  '[main] ipc handlers registered',
  '[main] tools-mcp health check ok (tools/list non-empty)',
  '[main] smoke self-exit'
)
foreach ($milestone in $milestones) {
  if (-not $smokeLog.Contains($milestone)) {
    throw "Packaged startup smoke missed milestone: $milestone"
  }
}
$survivors = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $packagedExe }
if ($survivors) {
  throw "Packaged startup smoke left Jarvis processes running: $($survivors.Id -join ', ')"
}
Write-Output "smoke=$smokeRoot"

$hash = Get-FileHash -LiteralPath $installer -Algorithm SHA256
$sumFile = Join-Path $repo 'dist-package\SHA256SUMS.txt'
("{0} *{1}" -f $hash.Hash.ToLowerInvariant(), (Split-Path $installer -Leaf)) |
  Set-Content -LiteralPath $sumFile -Encoding ascii

$signature = Get-AuthenticodeSignature -LiteralPath $installer
Write-Output "installer=$installer"
Write-Output "sha256=$($hash.Hash.ToLowerInvariant())"
Write-Output "signature=$($signature.Status)"
Write-Output "checksums=$sumFile"
