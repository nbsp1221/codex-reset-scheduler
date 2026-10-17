using System; using System.Diagnostics; using System.Threading.Tasks; using System.IO;
public class FakeCodex {
 public static async Task Relay(Stream source, Stream destination) {
  var bytes=new byte[4096]; int count;
  while((count=await source.ReadAsync(bytes,0,bytes.Length))>0) { await destination.WriteAsync(bytes,0,count); await destination.FlushAsync(); }
 }
 public static int Main(string[] args) {
 if(args.Length==1 && args[0]=="--version") { Console.WriteLine("codex-cli synthetic-native"); return 0; }
 if(args.Length!=2 || args[0]!="app-server" || args[1]!="--stdio") return 2;
 var info = new ProcessStartInfo(@@NODE@@, ((char)34).ToString() + @@LAUNCHER@@ + ((char)34).ToString() + " app-server --stdio");
 info.UseShellExecute=false; info.CreateNoWindow=true; info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
 using(var child=Process.Start(info)) {
  var input=Relay(Console.OpenStandardInput(),child.StandardInput.BaseStream); input.ContinueWith(t=>child.StandardInput.Close());
  var output=Relay(child.StandardOutput.BaseStream,Console.OpenStandardOutput()); var error=Relay(child.StandardError.BaseStream,Console.OpenStandardError());
  child.WaitForExit(); Task.WaitAll(output,error); return child.ExitCode;
 } } }
