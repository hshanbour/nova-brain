param([Parameter(Mandatory=$true)][ValidateSet('get','set','delete','status')][string]$Action,[Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NovaCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public UInt32 Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist,AttributeCount; public IntPtr Attributes; public string TargetAlias,UserName; }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static void Set(string target,string value){var bytes=System.Text.Encoding.Unicode.GetBytes(value);var ptr=Marshal.AllocHGlobal(bytes.Length);try{Marshal.Copy(bytes,0,ptr,bytes.Length);var c=new CREDENTIAL{Type=1,TargetName=target,CredentialBlobSize=(uint)bytes.Length,CredentialBlob=ptr,Persist=2,UserName=Environment.UserName};if(!CredWrite(ref c,0))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}finally{for(int i=0;i<bytes.Length;i++)Marshal.WriteByte(ptr,i,0);Array.Clear(bytes,0,bytes.Length);Marshal.FreeHGlobal(ptr);}}
  public static string Get(string target){IntPtr ptr;if(!CredRead(target,1,0,out ptr))return null;try{var c=(CREDENTIAL)Marshal.PtrToStructure(ptr,typeof(CREDENTIAL));return Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2);}finally{CredFree(ptr);}}
  public static bool Delete(string target){return CredDelete(target,1,0)||Marshal.GetLastWin32Error()==1168;}
}
'@
switch($Action){
  'get' { $value=[NovaCredentialManager]::Get($Target); if($null -eq $value){exit 3}; [Console]::Out.Write($value) }
  'set' { $value=[Console]::In.ReadToEnd(); [NovaCredentialManager]::Set($Target,$value); [Console]::Out.Write('stored') }
  'delete' { [void][NovaCredentialManager]::Delete($Target); [Console]::Out.Write('deleted') }
  'status' { if($null -eq [NovaCredentialManager]::Get($Target)){[Console]::Out.Write('missing')}else{[Console]::Out.Write('configured')} }
}
