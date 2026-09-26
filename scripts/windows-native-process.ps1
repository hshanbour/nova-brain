function Invoke-NovaNativeProbe {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$FilePath,
    [string[]]$ArgumentValues=@()
  )

  $previousErrorActionPreference=$ErrorActionPreference
  $exitCode=-1
  $stdout=@()
  $stderr=@()
  $stderrPath=[System.IO.Path]::GetTempFileName()
  try {
    # Windows PowerShell 5.1 promotes native stderr records according to
    # ErrorActionPreference even when the native process exits successfully.
    # Redirect stderr separately so native exit status remains authoritative
    # without contaminating machine-readable stdout.
    $ErrorActionPreference='Continue'
    $stdout=@(& $FilePath @ArgumentValues 2> $stderrPath)
    $exitCode=$LASTEXITCODE
    if(Test-Path -LiteralPath $stderrPath -PathType Leaf){
      $stderr=@([System.IO.File]::ReadAllLines($stderrPath))
    }
  } finally {
    $ErrorActionPreference=$previousErrorActionPreference
    if(Test-Path -LiteralPath $stderrPath){Remove-Item -LiteralPath $stderrPath -Force}
  }

  [pscustomobject]@{
    ExitCode=[int]$exitCode
    Stdout=@($stdout | ForEach-Object { [string]$_ })
    Stderr=@($stderr | ForEach-Object { [string]$_ })
  }
}
