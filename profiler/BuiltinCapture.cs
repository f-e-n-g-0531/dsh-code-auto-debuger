using System.Diagnostics;
using System.Security.Principal;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Session;

internal static class BuiltinCapture
{
    internal static object ListProcesses()
    {
        var rows = new List<(int Pid, string Name, string StartTicks)>();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    if (process.Id > 0 && !process.HasExited)
                        rows.Add((process.Id, process.ProcessName, process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)));
                }
                catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or ArgumentException)
                {
                    // Protected or exiting processes cannot be reliably identified for capture.
                }
            }
        }
        return new { processes = rows.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ThenBy(p => p.Pid)
            .Select(p => new { pid = p.Pid, name = p.Name, startTicks = p.StartTicks }).ToArray() };
    }

    private static int? FindInitialThread(Process process, DateTime started)
    {
        if (!OperatingSystem.IsWindows()) return null;
        int? id = null;
        var earliest = DateTime.MaxValue;
        try
        {
            foreach (ProcessThread thread in process.Threads)
            {
                using (thread)
                {
                    try
                    {
                        var created = thread.StartTime.ToUniversalTime();
                        if (created < earliest) { earliest = created; id = thread.Id; }
                        else if (created == earliest) id = null;
                    }
                    catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
                }
            }
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { return null; }
        return Math.Abs((earliest - started).TotalMilliseconds) <= 100 ? id : null;
    }

    internal static object Run(int pid, int seconds, string output, long expectedStartTicks)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10)) throw new PlatformNotSupportedException("内置 ETW 录制要求 Windows 10 或更高版本。");
        if (pid <= 0 || seconds is < 5 or > 15) throw new ArgumentException("需要有效的 PID，录制时长须为 5–15 秒。");
        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            throw new UnauthorizedAccessException("内置 ETW 内核 CPU 采样需要管理员权限；也可直接导入 ETL。");
        using var target = Process.GetProcessById(pid);
        // Hold a handle to the selected process for the entire recording.
        _ = target.SafeHandle;
        string name = target.ProcessName;
        DateTime started = target.StartTime.ToUniversalTime();
        if (started.Ticks != expectedStartTicks || target.HasExited)
            throw new InvalidOperationException("目标进程已退出或发生变化，请刷新列表后重新选择。");
        var firstThreadId = FindInitialThread(target, started);
        var destination = new FileInfo(output);
        if (!destination.Extension.Equals(".etl", StringComparison.OrdinalIgnoreCase) || destination.Exists)
            throw new ArgumentException("输出需要是尚不存在的 .etl 文件。");
        string tag = "DSH.CPU." + Guid.NewGuid().ToString("N");
        var scratch = Directory.CreateTempSubdirectory("dsh-profiler-capture-");
        using var stop = new CancellationTokenSource();
        ConsoleCancelEventHandler interrupt = (_, e) => { e.Cancel = true; stop.Cancel(); };
        Console.CancelKeyPress += interrupt;
        try
        {
            string kernel = Path.Combine(scratch.FullName, "kernel.etl");
            string dxgi = Path.Combine(scratch.FullName, "dxgi.etl");
            string merged = Path.Combine(scratch.FullName, "merged.etl");
            const TraceEventSessionOptions create = TraceEventSessionOptions.Create | TraceEventSessionOptions.NoRestartOnCreate;
            using (var cpu = new TraceEventSession(tag, kernel, create) { StopOnDispose = true, MaximumFileMB = 192, BufferSizeMB = 32 })
            using (var presents = new TraceEventSession(tag + ".DXGI", dxgi, create) { StopOnDispose = true, MaximumFileMB = 24, BufferSizeMB = 8 })
            {
                // Never use the global NT Kernel Logger name or attach to an existing session.
                cpu.EnableKernelProvider(KernelTraceEventParser.Keywords.Profile | KernelTraceEventParser.Keywords.ImageLoad | KernelTraceEventParser.Keywords.Process | KernelTraceEventParser.Keywords.Thread, KernelTraceEventParser.Keywords.Profile);
                presents.EnableProvider(AnalysisEntry.Dxgi, TraceEventLevel.Verbose, 0xF, new TraceEventProviderOptions { ProcessIDFilter = new List<int> { pid } });
                if (target.WaitForExit(seconds * 1000) || stop.IsCancellationRequested)
                    throw new InvalidOperationException("目标退出或采集取消，未生成报告。");
                if (!presents.Stop() || !cpu.Stop()) throw new InvalidOperationException("未能正常结束自己的 ETW 会话。");
            }
            TraceEventSession.Merge(new[] { kernel, dxgi }, merged);
            File.Move(merged, destination.FullName);
            return new { pid, name, startUtc = started, firstThreadId };
        }
        finally
        {
            Console.CancelKeyPress -= interrupt;
            scratch.Delete(recursive: true);
        }
    }
}
