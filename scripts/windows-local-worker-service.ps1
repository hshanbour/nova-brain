param([Parameter(Mandatory=$true)][ValidateSet('install','uninstall','status')][string]$Action,[string]$PreviewUrl)
$ErrorActionPreference='Stop'; $name='NovaBrain Persistent Local Worker'
if($Action -eq 'status'){ $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; if($null -eq $task){[Console]::Out.Write('not_installed')}else{[Console]::Out.Write('installed')}; exit }
if($Action -eq 'uninstall'){ Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; [Console]::Out.Write('uninstalled'); exit }
if($PreviewUrl -notmatch '^https://[a-z0-9.-]+\.vercel\.app/?$'){throw 'A protected HTTPS Vercel Preview URL is required.'}
$node=(Get-Command node.exe).Source; $script=(Resolve-Path (Join-Path $PSScriptRoot 'persistent-local-worker.js')).Path; $root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$arguments='"'+$script+'" --preview-url "'+$PreviewUrl.TrimEnd('/')+'"'; $taskAction=New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Settings $settings -Description 'Bounded Nova Self-Development worker; credentials load from Windows Credential Manager.' -Force | Out-Null
[Console]::Out.Write('installed')
