Set-StrictMode -Version Latest

function Wait-NovaExistingWorkerSafeIdle {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$GetSnapshot,
    [Parameter(Mandatory = $true)][int]$ExpectedPid,
    [int]$SafeIdleTimeoutSeconds = 270,
    [int]$ConfirmationTimeoutSeconds = 30,
    [int]$SampleIntervalMilliseconds = 500,
    [scriptblock]$GetNow = { [DateTimeOffset]::UtcNow },
    [scriptblock]$Wait = { param([int]$Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
  )

  $deadline=(& $GetNow).AddSeconds($SafeIdleTimeoutSeconds)
  $first=$null
  $confirmationDeadline=$null
  $lastState='unknown'
  do {
    $sample=& $GetSnapshot
    $now=& $GetNow
    if($null -ne $sample){
      $samplePid=if($null -ne $sample.PSObject.Properties['Pid']){[int]$sample.Pid}else{0}
      $state=if($null -ne $sample.PSObject.Properties['State']){[string]$sample.State}else{''}
      if(-not [string]::IsNullOrWhiteSpace($state)){$lastState=$state}
      if($ExpectedPid -le 0){
        if($sample.SafeToReplace -eq $true){return [pscustomobject]@{Ready=$true;Reason=$null;Pid=$samplePid;State=$lastState;Snapshot=$sample}}
        return [pscustomobject]@{Ready=$false;Reason='unexpected_existing_worker';Pid=$samplePid;State=$lastState;Snapshot=$sample}
      }
      if($samplePid -ne $ExpectedPid){return [pscustomobject]@{Ready=$false;Reason='process_changed';Pid=$samplePid;State=$lastState;Snapshot=$sample}}
      if($sample.ProcessAlive -ne $true){return [pscustomobject]@{Ready=$false;Reason='process_lost';Pid=$samplePid;State=$lastState;Snapshot=$sample}}
      if([int]$sample.LockPid -ne $ExpectedPid){return [pscustomobject]@{Ready=$false;Reason='lock_changed';Pid=$samplePid;State=$lastState;Snapshot=$sample}}
      if($sample.SingletonViolation -eq $true){return [pscustomobject]@{Ready=$false;Reason='singleton_violation';Pid=$samplePid;State=$lastState;Snapshot=$sample}}
      if($sample.CurrentBindingMismatch -eq $true){return [pscustomobject]@{Ready=$false;Reason='binding_mismatch';Pid=$samplePid;State=$lastState;Snapshot=$sample}}
      if($sample.TerminalFailure -eq $true){return [pscustomobject]@{Ready=$false;Reason='terminal_state';Pid=$samplePid;State=$lastState;Snapshot=$sample}}
      if($sample.SafeToReplace -eq $true){
        if($null -eq $first){
          $first=$sample
          $confirmationDeadline=$now.AddSeconds($ConfirmationTimeoutSeconds)
        } else {
          try {
            $heartbeatAdvanced=[DateTimeOffset]::Parse([string]$sample.LastHeartbeat) -gt [DateTimeOffset]::Parse([string]$first.LastHeartbeat)
            $pollAdvanced=[DateTimeOffset]::Parse([string]$sample.LastSuccessfulPoll) -gt [DateTimeOffset]::Parse([string]$first.LastSuccessfulPoll)
          } catch {
            $heartbeatAdvanced=$false
            $pollAdvanced=$false
          }
          if($heartbeatAdvanced -and $pollAdvanced){return [pscustomobject]@{Ready=$true;Reason=$null;Pid=$samplePid;State=$lastState;Snapshot=$sample}}
          if($now -ge $confirmationDeadline){return [pscustomobject]@{Ready=$false;Reason='idle_confirmation_timeout';Pid=$samplePid;State=$lastState;Snapshot=$sample}}
        }
      } else {
        $first=$null
        $confirmationDeadline=$null
      }
    }
    & $Wait $SampleIntervalMilliseconds
  } while((& $GetNow) -lt $deadline)
  return [pscustomobject]@{Ready=$false;Reason='safe_idle_timeout';Pid=$ExpectedPid;State=$lastState;Snapshot=$sample}
}

function Wait-NovaWorkerConvergence {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$GetSnapshot,
    [Parameter(Mandatory = $true)][int]$OldPid,
    [int]$StartupTimeoutSeconds = 195,
    [int]$PollAdvanceTimeoutSeconds = 30,
    [int]$SampleIntervalMilliseconds = 500,
    [scriptblock]$GetNow = { [DateTimeOffset]::UtcNow },
    [scriptblock]$Wait = { param([int]$Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
  )

  $deadline=(& $GetNow).AddSeconds($StartupTimeoutSeconds)
  $first=$null
  $pollDeadline=$null
  $lastPid=0
  $lastState='unknown'
  do {
    $sample=& $GetSnapshot
    $now=& $GetNow
    if($null -ne $sample){
      if($null -ne $sample.PSObject.Properties['Pid']){$lastPid=[int]$sample.Pid}
      if($null -ne $sample.PSObject.Properties['State'] -and -not [string]::IsNullOrWhiteSpace([string]$sample.State)){$lastState=[string]$sample.State}
      $isReplacement=[int]$sample.Pid -gt 0 -and [int]$sample.Pid -ne $OldPid
      if($isReplacement -and $sample.TerminalFailure -eq $true){
        return [pscustomobject]@{Converged=$false;Reason='terminal_state';Pid=[int]$sample.Pid;State=$lastState}
      }
      if($isReplacement -and $sample.BindingMismatch -eq $true){
        return [pscustomobject]@{Converged=$false;Reason='binding_mismatch';Pid=[int]$sample.Pid;State=$lastState}
      }
      if($isReplacement -and $sample.Converged -eq $true){
        if($null -eq $first -or [int]$first.Pid -ne [int]$sample.Pid){
          $first=$sample
          $pollDeadline=$now.AddSeconds($PollAdvanceTimeoutSeconds)
        } else {
          try {
            $heartbeatAdvanced=[DateTimeOffset]::Parse([string]$sample.LastHeartbeat) -gt [DateTimeOffset]::Parse([string]$first.LastHeartbeat)
            $pollAdvanced=[DateTimeOffset]::Parse([string]$sample.LastSuccessfulPoll) -gt [DateTimeOffset]::Parse([string]$first.LastSuccessfulPoll)
          } catch {
            $heartbeatAdvanced=$false
            $pollAdvanced=$false
          }
          if($heartbeatAdvanced -and $pollAdvanced){
            return [pscustomobject]@{Converged=$true;Reason=$null;Pid=[int]$sample.Pid;LastHeartbeat=$sample.LastHeartbeat;LastSuccessfulPoll=$sample.LastSuccessfulPoll}
          }
        }
      }
      if($null -ne $pollDeadline -and $now -ge $pollDeadline){
        return [pscustomobject]@{Converged=$false;Reason='poll_advance_timeout';Pid=[int]$first.Pid;State=$lastState}
      }
    }
    & $Wait $SampleIntervalMilliseconds
  } while((& $GetNow) -lt $deadline)
  return [pscustomobject]@{Converged=$false;Reason='startup_timeout';Pid=$lastPid;State=$lastState}
}

function Invoke-NovaWorkerCutover {
  param(
    [Parameter(Mandatory = $true)][pscustomobject]$Current,
    [Parameter(Mandatory = $true)][scriptblock]$StopCurrent,
    [Parameter(Mandatory = $true)][scriptblock]$AwaitCurrentStopped,
    [Parameter(Mandatory = $true)][scriptblock]$InstallReplacement,
    [Parameter(Mandatory = $true)][scriptblock]$StartReplacement,
    [Parameter(Mandatory = $true)][scriptblock]$AwaitReplacementConverged,
    [Parameter(Mandatory = $true)][scriptblock]$Rollback
  )

  if ($Current.Converged -eq $true) {
    return [pscustomobject]@{ Idempotent = $true; Pid = [int]$Current.Pid }
  }
  if ($Current.SafeToReplace -ne $true) {
    throw 'The existing persistent worker is not at a verified safe idle boundary.'
  }

  $replacementAttempted = $false
  try {
    if ([int]$Current.Pid -gt 0) {
      & $StopCurrent
      if ((& $AwaitCurrentStopped) -ne $true) {
        throw 'The existing persistent worker did not stop and release its lock within the bounded timeout.'
      }
    }

    $replacementAttempted = $true
    & $InstallReplacement
    & $StartReplacement
    $converged = & $AwaitReplacementConverged
    if ($null -eq $converged -or $converged.Converged -ne $true) {
      $reason=if($null -ne $converged -and $null -ne $converged.PSObject.Properties['Reason']){[string]$converged.Reason}else{'unknown'}
      $failedPid=if($null -ne $converged -and $null -ne $converged.PSObject.Properties['Pid']){[int]$converged.Pid}else{0}
      $failedState=if($null -ne $converged -and $null -ne $converged.PSObject.Properties['State']){[string]$converged.State}else{'unknown'}
      throw "The replacement persistent worker did not converge within the bounded timeout (reason=$reason; pid=$failedPid; state=$failedState)."
    }
    return [pscustomobject]@{ Idempotent = $false; Pid = [int]$converged.Pid }
  }
  catch {
    $originalFailure = $_
    if ($replacementAttempted) {
      try { & $Rollback }
      catch { throw 'The worker replacement failed and the prior worker could not be restored to a verified healthy state.' }
    }
    throw $originalFailure
  }
}
