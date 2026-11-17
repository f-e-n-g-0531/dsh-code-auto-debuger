using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace Dsh.VisualStudio.Bridge;

internal static class Native
{
    [DllImport("ole32.dll")] internal static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable table);
    [DllImport("ole32.dll")] internal static extern int CreateBindCtx(int reserved, out IBindCtx context);
    [DllImport("ole32.dll")] internal static extern int CoRegisterMessageFilter(IOleMessageFilter? filter, out IOleMessageFilter? previous);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")] internal static extern bool PeekMessage(out Message message, nint window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] internal static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] internal static extern nint DispatchMessage(ref Message message);
    [StructLayout(LayoutKind.Sequential)] internal struct Message
    {
        public nint Window; public uint Id; public nuint WParam; public nint LParam;
        public uint Time; public int X; public int Y; public uint Private;
    }
    internal static void Pump()
    {
        while (PeekMessage(out var msg, 0, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
    }
    internal static void Release(object? obj)
    {
        if (obj != null && Marshal.IsComObject(obj)) Marshal.ReleaseComObject(obj);
    }
}

[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOleMessageFilter
{
    [PreserveSig] int HandleInComingCall(int type, nint caller, int tick, nint info);
    [PreserveSig] int RetryRejectedCall(nint callee, int tick, int rejectType);
    [PreserveSig] int MessagePending(nint callee, int tick, int pendingType);
}

// Never ask COM to replay a rejected call, including mutations. Caller gets BUSY.
internal sealed class NoRetryFilter : IOleMessageFilter
{
    public int HandleInComingCall(int type, nint caller, int tick, nint info) => 0;
    public int RetryRejectedCall(nint callee, int tick, int rejectType) => -1;
    public int MessagePending(nint callee, int tick, int pendingType) => 2;
}

internal sealed class StaHost : IDisposable
{
    private readonly BlockingCollection<Action> queue = new(32);
    private readonly Thread thread;
    public StaHost()
    {
        thread = new Thread(Run) { IsBackground = true, Name = "VS COM STA" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }
    private void Run()
    {
        Native.CoRegisterMessageFilter(new NoRetryFilter(), out var previous);
        try
        {
            while (!queue.IsCompleted)
            {
                if (queue.TryTake(out var action, 15)) action();
                Native.Pump();
            }
        }
        finally { Native.CoRegisterMessageFilter(previous, out _); }
    }
    public T Invoke<T>(Func<T> action)
    {
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.Add(() => { try { completion.SetResult(action()); } catch (Exception e) { completion.SetException(e); } });
        // A hung in-flight mutation cannot be cancelled or replayed safely. Exit
        // transport after timeout; process exit releases COM, never kills VS.
        if (!completion.Task.Wait(TimeSpan.FromSeconds(30)))
        {
            Console.Error.WriteLine("COM call timed out; outcome unknown; bridge exiting without replay.");
            Environment.Exit(3);
        }
        return completion.Task.GetAwaiter().GetResult();
    }
    public void Dispose() { queue.CompleteAdding(); thread.Join(TimeSpan.FromSeconds(2)); queue.Dispose(); }
}
