using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Dsh.VisualStudio.Bridge;

internal static class Program
{
    private static readonly JsonSerializerOptions Options = new() { MaxDepth = 24 };
    private static int Main(string[] args)
    {
        if (args.Length != 0) { Console.Error.WriteLine("Usage: dsh-vs-bridge (JSONL stdin/stdout)"); return 2; }
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
        { Console.Error.WriteLine("Windows x64 is required"); return 2; }
        Console.OutputEncoding = new UTF8Encoding(false);
        using var sta = new StaHost();
        var session = new VisualStudioSession();
        try
        {
            foreach (var (line, inputError) in Protocol.ReadLines(Console.OpenStandardInput()))
            {
                object? id = null;
                try
                {
                    if (inputError != null) throw new BridgeError("INVALID_REQUEST", inputError);
                    var request = Protocol.Parse(line!);
                    id = request.Id;
                    var value = sta.Invoke(() => session.Execute(request));
                    Emit(new { protocol = 1, id, ok = true, value });
                }
                catch (Exception e)
                {
                    e = Unwrap(e);
                    string code = e switch
                    {
                        BridgeError b => b.Code,
                        JsonException or ArgumentException or FormatException or OverflowException => "INVALID_REQUEST",
                        COMException c when c.HResult is unchecked((int)0x80010001) or unchecked((int)0x8001010A) => "BUSY",
                        COMException => "COM_ERROR",
                        _ => "BRIDGE_ERROR"
                    };
                    string message = e is BridgeError ? e.Message : code switch
                    {
                        "BUSY" => "VS rejected the call as busy; no automatic replay was performed",
                        "COM_ERROR" => "COM call failed; a mutation may have unknown outcome; inspect before retrying",
                        "INVALID_REQUEST" => "Malformed request or invalid parameter",
                        _ => "Bridge operation failed; inspect before retrying any mutation"
                    };
                    Console.Error.WriteLine(code + ": " + e.GetType().Name);
                    Emit(new { protocol = 1, id, ok = false, error = new { code, message } });
                }
            }
        }
        finally { sta.Invoke(() => { session.Dispose(); return true; }); }
        return 0;
    }
    private static Exception Unwrap(Exception e)
    {
        while (e is AggregateException && e.InnerException != null) e = e.InnerException;
        return e;
    }
    private static void Emit(object value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, Options)); Console.Out.Flush();
    }
}
