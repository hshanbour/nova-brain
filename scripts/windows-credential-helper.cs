using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class NovaCredentialHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct Credential { public UInt32 Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist,AttributeCount; public IntPtr Attributes; public string TargetAlias,UserName; }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CredWrite(ref Credential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);

  private static void Stage(string value) { Console.Error.WriteLine("NOVA_STAGE:"+value); }
  private static bool ValidTarget(string value) { return value!=null&&value.StartsWith("NovaBrain/LocalWorker/",StringComparison.Ordinal)&&value.Length<=160; }
  private static string Get(string target) { IntPtr ptr;if(!CredRead(target,1,0,out ptr)){int error=Marshal.GetLastWin32Error();if(error==1168)return null;throw new Win32Exception(error);}try{Credential value=(Credential)Marshal.PtrToStructure(ptr,typeof(Credential));return Marshal.PtrToStringUni(value.CredentialBlob,(int)value.CredentialBlobSize/2);}finally{CredFree(ptr);} }
  private static void Set(string target,string value) { byte[] bytes=Encoding.Unicode.GetBytes(value);IntPtr ptr=Marshal.AllocHGlobal(bytes.Length);try{Marshal.Copy(bytes,0,ptr,bytes.Length);Credential credential=new Credential{Type=1,TargetName=target,CredentialBlobSize=(uint)bytes.Length,CredentialBlob=ptr,Persist=2,UserName=Environment.UserName};if(!CredWrite(ref credential,0))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{for(int i=0;i<bytes.Length;i++)Marshal.WriteByte(ptr,i,0);Array.Clear(bytes,0,bytes.Length);Marshal.FreeHGlobal(ptr);} }
  public static int Main(string[] args) {
    Stage("script_started");
    if(args.Length<2||!ValidTarget(args[1])){Console.Error.WriteLine("NOVA_ERROR:invalid_arguments");return 2;}
    string action=args[0],target=args[1];
    try {
      Stage("native_api_loading");Stage("native_api_loaded");
      if(action=="get"||action=="status"){Stage("credread_start");string value=Get(target);Stage("credread_complete");if(action=="status"){Console.Out.Write(value==null?"missing":"configured");Stage("output_complete");return 0;}if(value==null)return 3;Console.Out.Write(value);Stage("output_complete");return 0;}
      if(action=="get-pair"){if(args.Length!=3||!ValidTarget(args[2])){Console.Error.WriteLine("NOVA_ERROR:invalid_arguments");return 2;}Stage("credread_start");string first=Get(target),second=Get(args[2]);Stage("credread_complete");if(first==null||second==null)return 3;Console.Out.Write("[\""+Convert.ToBase64String(Encoding.UTF8.GetBytes(first))+"\",\""+Convert.ToBase64String(Encoding.UTF8.GetBytes(second))+"\"]");Stage("output_complete");return 0;}
      if(action=="set"){string value=Console.In.ReadToEnd();Set(target,value);Console.Out.Write("stored");Stage("output_complete");return 0;}
      if(action=="delete"){if(!CredDelete(target,1,0)&&Marshal.GetLastWin32Error()!=1168)throw new Win32Exception(Marshal.GetLastWin32Error());Console.Out.Write("deleted");Stage("output_complete");return 0;}
      Console.Error.WriteLine("NOVA_ERROR:invalid_arguments");return 2;
    } catch { Console.Error.WriteLine("NOVA_ERROR:credential_read_failed");return 11; }
  }
}
