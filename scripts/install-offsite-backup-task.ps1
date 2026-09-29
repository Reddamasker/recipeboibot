$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'fetch-offsite-backup.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Backup script not found: $scriptPath" }

$taskName = 'Recipeboibot Offsite Backup'
$powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At '06:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Scheduled task installed and started: $taskName"

