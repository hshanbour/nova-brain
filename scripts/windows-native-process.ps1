function Invoke-NovaNativeProbe {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$FilePath,
    [string[]]$ArgumentValues=@()
  )

  $previousErrorActionPreference=$ErrorActionPreference
  $exitCode=-1
  $output=@()
  try {
    # Windows PowerShell 5.1 promotes native stderr records according to
    # ErrorActionPreference even when the native process exits successfully.
    # Native process exit status is the authoritative success boundary.
    $ErrorActionPreference='Continue'
    $output=@(& $FilePath @ArgumentValues 2>&1)
    $exitCode=$LASTEXITCODE
  } finally {
    $ErrorActionPreference=$previousErrorActionPreference
  }

  [pscustomobject]@{
    ExitCode=[int]$exitCode
    Output=@($output | ForEach-Object { [string]$_ })
  }
}
