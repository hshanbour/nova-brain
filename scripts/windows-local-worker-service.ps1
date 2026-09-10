param(
  [Parameter(Mandatory=$true)][ValidateSet('install','uninstall','status')][string]$Action,
  [string]$PreviewUrl,
  [string]$RepositoryRoot
)
$ErrorActionPreference='Stop'
$name='NovaBrain Persistent Local Worker'
if($Action -eq 'status'){ $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; if($null -eq $task){[Console]::Out.Write('not_installed')}else{[Console]::Out.Write('installed')}; exit }
if($Action -eq 'uninstall'){ Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; [Console]::Out.Write('uninstalled'); exit }
if($PreviewUrl -notmatch '^https://[a-z0-9.-]+\.vercel\.app/?$'){throw 'A protected HTTPS Vercel Preview URL is required.'}

$node=(Get-Command node.exe).Source
$git=(Get-Command git.exe -ErrorAction Stop).Source
if(-not [System.IO.Path]::IsPathRooted($git) -or [System.IO.Path]::GetFileName($git) -ne 'git.exe'){throw 'A validated Git executable is required.'}
$sourceRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if([string]::IsNullOrWhiteSpace($RepositoryRoot)){$RepositoryRoot=$sourceRoot}
$root=(Resolve-Path -LiteralPath $RepositoryRoot).Path
$runtimeVersion=(& $git -C $sourceRoot rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $runtimeVersion -notmatch '^[0-9a-f]{40}$'){throw 'The trusted worker runtime source commit could not be resolved.'}
$runtimeSourceChanges=@(& $git -C $sourceRoot status --porcelain=v1 --untracked-files=all -- scripts src package.json package-lock.json)
if($LASTEXITCODE -ne 0 -or $runtimeSourceChanges.Count -ne 0){throw 'The trusted worker runtime source contains uncommitted content.'}
$runtimeFiles=@(& $git -C $sourceRoot ls-tree -r --name-only $runtimeVersion -- scripts src package.json package-lock.json)
if($LASTEXITCODE -ne 0 -or $runtimeFiles.Count -eq 0){throw 'The trusted worker runtime manifest could not be resolved.'}
function Assert-RuntimeContent([string]$CandidateRoot){
  foreach($relative in $runtimeFiles){
    $candidate=Join-Path $CandidateRoot $relative
    if(-not (Test-Path -LiteralPath $candidate -PathType Leaf)){throw 'The worker runtime snapshot is incomplete.'}
    $expected=(& $git -C $sourceRoot rev-parse ($runtimeVersion+':'+$relative)).Trim()
    $actual=(& $git hash-object --no-filters -- $candidate).Trim()
    if($LASTEXITCODE -ne 0 -or $actual -ne $expected){throw 'The worker runtime snapshot does not match its immutable commit.'}
  }
}

$runtime=Join-Path $env:LOCALAPPDATA 'NovaBrain\PersistentWorker'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$helper=Join-Path $runtime 'NovaCredentialHelper.exe'
if(-not (Test-Path -LiteralPath $helper -PathType Leaf)){throw 'The prevalidated Windows credential helper is required at the stable runtime path.'}
$credentialPrefix='NovaBrain/LocalWorker/'
$novaTarget=$credentialPrefix+('NOVA_LOCAL_WORKER_'+'TOKEN')
$vercelTarget=$credentialPrefix+('VERCEL_AUTOMATION_'+'BYPASS')
$novaStatus=& $helper status $novaTarget
if($LASTEXITCODE -ne 0 -or $novaStatus -notin @('configured','missing')){throw 'The stable Windows credential helper failed its bounded status probe.'}
$vercelStatus=& $helper status $vercelTarget
if($LASTEXITCODE -ne 0 -or $vercelStatus -notin @('configured','missing')){throw 'The stable Windows credential helper failed its bounded status probe.'}

$versions=Join-Path $runtime 'worker-runtimes'
New-Item -ItemType Directory -Path $versions -Force | Out-Null
$finalRuntime=Join-Path $versions $runtimeVersion
$stagedRuntime=Join-Path $versions ($runtimeVersion+'.install-'+[Guid]::NewGuid().ToString('N'))
$stagedArchive=$stagedRuntime+'.zip'
try {
  if(-not (Test-Path -LiteralPath $finalRuntime -PathType Container)){
    New-Item -ItemType Directory -Path $stagedRuntime | Out-Null
    & $git -c core.autocrlf=false -C $sourceRoot archive --format=zip --output=$stagedArchive $runtimeVersion -- scripts src package.json package-lock.json
    if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $stagedArchive -PathType Leaf)){throw 'The canonical worker runtime export failed.'}
    Expand-Archive -LiteralPath $stagedArchive -DestinationPath $stagedRuntime
    Assert-RuntimeContent $stagedRuntime
    $stagedScript=Join-Path $stagedRuntime 'scripts\persistent-local-worker.js'
    $verification=& $node $stagedScript --verify-runtime --runtime-version $runtimeVersion --repository-root $root
    if($LASTEXITCODE -ne 0){throw 'The staged worker runtime failed its bounded validation.'}
    $verified=$verification | ConvertFrom-Json
    if(-not $verified.ok -or $verified.runtimeVersion -ne $runtimeVersion -or $verified.repositoryRoot -ne $root){throw 'The staged worker runtime binding could not be verified.'}
    Move-Item -LiteralPath $stagedRuntime -Destination $finalRuntime
  }
  $script=Join-Path $finalRuntime 'scripts\persistent-local-worker.js'
  Assert-RuntimeContent $finalRuntime
  $verification=& $node $script --verify-runtime --runtime-version $runtimeVersion --repository-root $root
  if($LASTEXITCODE -ne 0){throw 'The installed worker runtime failed its bounded validation.'}
  $verified=$verification | ConvertFrom-Json
  if(-not $verified.ok -or $verified.runtimeVersion -ne $runtimeVersion -or $verified.repositoryRoot -ne $root){throw 'The installed worker runtime binding could not be verified.'}

  $arguments='"'+$script+'" --preview-url "'+$PreviewUrl.TrimEnd('/')+'" --repository-root "'+$root+'" --runtime-version "'+$runtimeVersion+'" --git-executable "'+$git+'" --credential-helper "'+$helper+'"'
  $taskAction=New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $root
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Settings $settings -Description 'Versioned Nova worker runtime with an independently bound task workspace.' -Force | Out-Null
  $installedAction=(Get-ScheduledTask -TaskName $name -ErrorAction Stop).Actions | Select-Object -First 1
  if($installedAction.Execute -ne $node -or $installedAction.Arguments -notlike ('*"'+$script+'"*') -or $installedAction.Arguments -notlike ('*--repository-root "'+$root+'"*') -or $installedAction.Arguments -notlike ('*--runtime-version "'+$runtimeVersion+'"*') -or $installedAction.Arguments -notlike ('*--credential-helper "'+$helper+'"*')){throw 'The Scheduled Task immutable runtime binding could not be verified.'}
  [Console]::Out.Write('installed')
} finally {
  if(Test-Path -LiteralPath $stagedArchive){Remove-Item -LiteralPath $stagedArchive -Force}
  if(Test-Path -LiteralPath $stagedRuntime){Remove-Item -LiteralPath $stagedRuntime -Recurse -Force}
}
