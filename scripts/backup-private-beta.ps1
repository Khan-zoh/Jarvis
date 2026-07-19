[CmdletBinding()]
param(
  [string]$VaultDir = 'D:\JarvisBrain',
  [string]$UserDataDir = (Join-Path $env:APPDATA 'Jarvis'),
  [string]$BackupRoot = 'D:\JarvisBackups'
)

$ErrorActionPreference = 'Stop'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$destination = Join-Path $BackupRoot $stamp
New-Item -ItemType Directory -Force -Path $destination | Out-Null

if (Test-Path -LiteralPath $VaultDir) {
  $vaultArchive = Join-Path $destination 'JarvisBrain.zip'
  Compress-Archive -LiteralPath $VaultDir -DestinationPath $vaultArchive -CompressionLevel Optimal
  Write-Output "vault=$vaultArchive"
} else {
  Write-Warning "Vault not found: $VaultDir"
}

if (Test-Path -LiteralPath $UserDataDir) {
  # Models are reproducible downloads and can be close to 1 GB. Preserve only irreplaceable
  # settings, encrypted secrets, sessions, plugin state, and the derived brain index.
  $items = Get-ChildItem -LiteralPath $UserDataDir -Force |
    Where-Object { $_.Name -ne 'models' } |
    Select-Object -ExpandProperty FullName
  if ($items.Count -gt 0) {
    $appArchive = Join-Path $destination 'JarvisUserData-no-models.zip'
    Compress-Archive -LiteralPath $items -DestinationPath $appArchive -CompressionLevel Optimal
    Write-Output "userdata=$appArchive"
  }
} else {
  Write-Warning "Jarvis user data not found yet: $UserDataDir"
}

Get-ChildItem -LiteralPath $destination -File |
  Get-FileHash -Algorithm SHA256 |
  ForEach-Object { "{0} *{1}" -f $_.Hash.ToLowerInvariant(), (Split-Path $_.Path -Leaf) } |
  Set-Content -LiteralPath (Join-Path $destination 'SHA256SUMS.txt') -Encoding ascii

Write-Output "backup=$destination"
