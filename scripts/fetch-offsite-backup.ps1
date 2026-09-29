param(
  [string]$Destination = "$env:USERPROFILE\Documents\Recipeboibot Offsite Backups",
  [string]$Identity = "$env:USERPROFILE\.ssh\recipeboibot_ed25519",
  [string]$BackupKey = "$env:USERPROFILE\.ssh\recipeboibot-backup.key",
  [string]$Target = "root@89.223.123.75"
)

$ErrorActionPreference = 'Stop'
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"
$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
$node = "C:\Program Files\nodejs\node.exe"

foreach ($tool in @($ssh, $scp, $openssl, $node, $Identity)) {
  if (-not (Test-Path -LiteralPath $tool)) { throw "Required file not found: $tool" }
}

$destinationFull = [IO.Path]::GetFullPath($Destination)
$documentsFull = [IO.Path]::GetFullPath("$env:USERPROFILE\Documents")
if (-not $destinationFull.StartsWith($documentsFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The offsite backup directory must stay inside the current user Documents directory'
}
New-Item -ItemType Directory -Force -Path $destinationFull | Out-Null

$options = @('-i', $Identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes')
$latest = (& $ssh @options $Target "find /opt/recipeboibot/backups -maxdepth 1 -type f -name 'recipes-*.sqlite.enc' -printf '%f\n' | sort | tail -n 1").Trim()
if ($LASTEXITCODE -ne 0 -or $latest -notmatch '^recipes-[0-9]{8}T[0-9]{6}Z\.sqlite\.enc$') {
  throw 'The server did not return a valid latest backup filename'
}

$localArchive = Join-Path $destinationFull $latest
if (-not (Test-Path -LiteralPath $localArchive)) {
  & $scp @options "${Target}:/opt/recipeboibot/backups/$latest" $localArchive
  if ($LASTEXITCODE -ne 0) { throw 'Failed to download the encrypted backup' }
}

$keyDirectory = Split-Path -Parent $BackupKey
New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
if (-not (Test-Path -LiteralPath $BackupKey)) {
  & $scp @options "${Target}:/opt/recipeboibot/backups/backup.key" $BackupKey
  if ($LASTEXITCODE -ne 0) { throw 'Failed to download the backup key' }
  & icacls.exe $BackupKey /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("recipeboibot-backup-{0}.sqlite" -f [Guid]::NewGuid())
try {
  & $openssl enc -d -aes-256-cbc -pbkdf2 -in $localArchive -out $temporary -pass "file:$BackupKey"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to decrypt the verification copy' }
  $integrity = (& $node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{readOnly:true}); console.log(db.prepare('PRAGMA integrity_check').get().integrity_check); db.close();" $temporary).Trim()
  if ($LASTEXITCODE -ne 0 -or $integrity -ne 'ok') { throw "SQLite integrity_check: $integrity" }
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

& $ssh @options $Target "touch /opt/recipeboibot/backups/offsite-last-success"
if ($LASTEXITCODE -ne 0) { throw 'The backup was verified, but the server did not accept the offsite success marker' }

Write-Output "Offsite backup verified: $localArchive"

