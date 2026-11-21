param([switch]$AvailabilityProof,[switch]$Worker)
$ErrorActionPreference='Stop'
$profileRoot=Join-Path $env:LOCALAPPDATA 'NovaBrain\FreshaExecutor'
$expected=[System.IO.Path]::GetFullPath($profileRoot)
if($expected -ne $profileRoot -or $expected -notlike '*\NovaBrain\FreshaExecutor'){throw 'Unexpected profile location.'}
if(Test-Path -LiteralPath $profileRoot){
  $item=Get-Item -LiteralPath $profileRoot
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Profile cannot be a reparse point.'}
}else{New-Item -ItemType Directory -Path $profileRoot | Out-Null}
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($sid)
foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
$current=Get-Acl -LiteralPath $profileRoot
$allowedSids=@($sid.Value,'S-1-5-18')
$unsafeRules=@($current.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids -or $_.IsInherited })
if(-not $current.AreAccessRulesProtected -or $unsafeRules.Count -gt 0){
  Set-Acl -LiteralPath $profileRoot -AclObject $acl
}
$verified=Get-Acl -LiteralPath $profileRoot
if(-not $verified.AreAccessRulesProtected -or @($verified.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids -or $_.IsInherited }).Count -gt 0){throw 'Profile ACL verification failed.'}
$prepareArgs=@((Join-Path $PSScriptRoot 'fresha-browser-prepare.js'))
if($AvailabilityProof){$prepareArgs+='--availability-proof'}
if($Worker){$prepareArgs+='--worker'}
& (Get-Command node.exe).Source @prepareArgs
