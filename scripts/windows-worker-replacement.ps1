Set-StrictMode -Version Latest

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
      throw 'The replacement persistent worker did not converge within the bounded timeout.'
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
