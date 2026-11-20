using System.Globalization;
using System.Text.Json;
using Microsoft.Diagnostics.Symbols;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;

internal static class AnalysisEntry
{
    internal static readonly Guid Dxgi = new("ca11c036-0102-4a2d-a6ad-f03cfed5d3c9");
    private const int MaxSamples = 300_000;
    public static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("需要 Windows。");
            var result = args switch
            {
                ["processes"] => BuiltinCapture.ListProcesses(),
                ["record", var pid, var seconds, var target, var ticks] => BuiltinCapture.Run(ParseInt(pid), ParseInt(seconds), target, long.Parse(ticks, NumberStyles.None, CultureInfo.InvariantCulture)),
                ["inspect", var file] => WithLog(file, Inspect),
                ["frames", var file, var index] => WithLog(file, log => Frames(log, FindProcess(log, index))),
                ["analyze", var file, var index, var pdb, var start, var end] => AnalyzeFile(file, index, pdb, start, end),
                _ => throw new ArgumentException("用法：inspect ETL | frames ETL INDEX | analyze ETL INDEX PDBDIR START_MS END_MS | processes | record PID SECONDS OUTPUT.etl START_TICKS")
            };
            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    private static int ParseInt(string s) => int.Parse(s, NumberStyles.None, CultureInfo.InvariantCulture);
    private static double ParseMs(string s)
    {
        var n = double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);
        return double.IsFinite(n) && n >= 0 ? n : throw new ArgumentException("无效时间。");
    }

    private static object AnalyzeFile(string file, string index, string pdb, string start, string end)
    {
        var directory = ValidatePdbDirectory(pdb);
        return WithLog(file, log => Analyze(log, FindProcess(log, index), directory, ParseMs(start), ParseMs(end)));
    }

    private static string ValidatePdbDirectory(string input)
    {
        if (input.Length == 0) return "";
        var directory = new DirectoryInfo(Path.GetFullPath(input));
        var root = directory.Root.FullName;
        if (root.Length != 3 || root[1] != ':' || root[2] != '\\' ||
            new DriveInfo(root).DriveType is not (DriveType.Fixed or DriveType.Removable or DriveType.Ram))
            throw new ArgumentException("PDB 目录必须位于本地磁盘，不支持网络路径。");
        // Walk root-first so a redirected ancestor is rejected before following it.
        var components = new Stack<DirectoryInfo>();
        for (DirectoryInfo? part = directory; part != null; part = part.Parent) components.Push(part);
        foreach (var part in components)
        {
            var attributes = part.Attributes;
            if (attributes == (FileAttributes)(-1) || !attributes.HasFlag(FileAttributes.Directory))
                throw new ArgumentException("PDB 目录不存在或不是文件夹。");
            if (attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new ArgumentException("PDB 目录不能经过符号链接或联接点；请填写实际目录。");
        }
        return directory.FullName;
    }

    private static object WithLog(string input, Func<TraceLog, object> fn)
    {
        var file = new FileInfo(input);
        if (!file.Exists || file.Length is 0 or > 1_073_741_824 || !file.Extension.Equals(".etl", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("需要不超过 1 GiB 的 ETL 文件。");
        var scratch = Directory.CreateTempSubdirectory("dsh-profiler-index-");
        try
        {
            var index = Path.Combine(scratch.FullName, "trace.etlx");
            TraceLog.CreateFromEventTraceLogFile(file.FullName, index, new TraceLogOptions { KeepAllEvents = true, ConversionLog = TextWriter.Null });
            using var log = new TraceLog(index);
            return fn(log);
        }
        finally { scratch.Delete(recursive: true); }
    }

    private static TraceProcess FindProcess(TraceLog log, string index)
    {
        int id = ParseInt(index);
        return log.Processes.FirstOrDefault(p => (int)p.ProcessIndex == id && p.ProcessID > 0)
            ?? throw new ArgumentException("ETL 中不存在该进程实例。");
    }
    private static object Inspect(TraceLog log) => new
    {
        durationMs = log.SessionDuration.TotalMilliseconds,
        eventsLost = log.EventsLost,
        processes = log.Processes.Where(p => p.ProcessID > 0).OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).Take(4096).Select(p => new
        {
            index = (int)p.ProcessIndex, pid = p.ProcessID, name = p.Name,
            startMs = Math.Clamp(p.StartTimeRelativeMsec, 0, log.SessionDuration.TotalMilliseconds),
            endMs = Math.Clamp(p.EndTimeRelativeMsec, 0, log.SessionDuration.TotalMilliseconds)
        }).ToArray()
    };

    private static object Frames(TraceLog log, TraceProcess process)
    {
        var streams = new Dictionary<ulong, List<double>>();
        var warnings = new List<string>();
        bool truncated = false, unknown = false;
        foreach (var e in log.Events)
        {
            // DXGI manifest Present_Start (42), whose first field is pIDXGISwapChain.
            if (e.ProviderGuid != Dxgi || (int)e.ID != 42 || e.ProcessID != process.ProcessID || e.Process()?.ProcessIndex != process.ProcessIndex) continue;
            if (e.Version != 0 || e.EventDataLength < e.PointerSize || e.PointerSize is not (4 or 8)) { unknown = true; continue; }
            var raw = e.EventData();
            ulong chain = e.PointerSize == 8 ? BitConverter.ToUInt64(raw, 0) : BitConverter.ToUInt32(raw, 0);
            if (chain == 0) { unknown = true; continue; }
            if (!streams.TryGetValue(chain, out var times))
            {
                if (streams.Count >= 64) { truncated = true; continue; }
                streams[chain] = times = new();
            }
            if (times.Count >= 4000) { truncated = true; continue; }
            if (times.Count == 0 || e.TimeStampRelativeMSec > times[^1]) times.Add(e.TimeStampRelativeMSec);
        }
        if (unknown) warnings.Add("已跳过不支持的 DXGI Present 事件格式。");
        if (truncated) warnings.Add("Present 时间线已截断（每条交换链最多 4000 个事件）。");
        if (log.EventsLost != 0) warnings.Add("ETL 有丢失事件，长间隔可能不是真实慢帧。");
        return new { streams = streams.Where(kv => kv.Value.Count >= 2).OrderByDescending(kv => kv.Value.Count).Select(kv => new { swapChain = $"0x{kv.Key:X}", presents = kv.Value }).ToArray(), warnings };
    }

    private sealed record FunctionKey(int Module, ulong Rva, string Name);
    private sealed class Counter { public int Self; public int Inclusive; }
    private sealed class ThreadStats
    {
        public int Samples;
        public Dictionary<FunctionKey, Counter> Functions { get; } = new();
        public Dictionary<string, (string[] Frames, int Samples)> Stacks { get; } = new(StringComparer.Ordinal);
    }

    private static int? EstimateMainThread(TraceProcess process)
    {
        var created = process.StartTimeRelativeMsec;
        // Thread rundown at the start of a trace does not establish creation order.
        if (created <= 0) return null;
        var first = process.Threads.Where(t => t.ThreadID > 0 &&
                t.StartTimeRelativeMSec >= created && t.StartTimeRelativeMSec <= created + 100)
            .OrderBy(t => t.StartTimeRelativeMSec).Take(2).ToArray();
        return first.Length == 0 || (first.Length == 2 && first[0].StartTimeRelativeMSec == first[1].StartTimeRelativeMSec)
            ? null : first[0].ThreadID;
    }

    private static object Analyze(TraceLog log, TraceProcess process, string pdb, double start, double end)
    {
        if (start >= end || end > log.SessionDuration.TotalMilliseconds + 0.000001)
            throw new ArgumentException("分析区间必须在录制时间内。");
        var warnings = new List<string>();
        var threads = new Dictionary<int, ThreadStats>();
        using var symbols = new OfflineSymbols(process, pdb);
        int samples = 0, stackSamples = 0;
        bool truncated = false;
        foreach (var e in log.Events)
        {
            if (e.TimeStampRelativeMSec >= end) break;
            if (e.TimeStampRelativeMSec < start || e is not SampledProfileTraceData cpu || cpu.ProcessID != process.ProcessID || cpu.Process()?.ProcessIndex != process.ProcessIndex || cpu.ExecutingDPC || cpu.ExecutingISR || cpu.NonProcess) continue;
            if (samples >= MaxSamples) { truncated = true; break; }
            ++samples;
            if (!threads.TryGetValue(e.ThreadID, out var t)) threads[e.ThreadID] = t = new();
            t.Samples++;
            var stack = e.CallStack();
            if (stack != null) stackSamples++;
            var ip = cpu.IntructionPointerCodeAddress();
            var names = new List<FunctionKey>();
            if (ip != null) names.Add(symbols.Resolve(ip, e.TimeStampRelativeMSec));
            for (int depth = 0; stack != null && depth < 128; depth++, stack = stack.Caller)
            {
                var key = symbols.Resolve(stack.CodeAddress, e.TimeStampRelativeMSec);
                if (depth != 0 || names.Count == 0 || names[0] != key) names.Add(key);
            }
            if (names.Count == 0) names.Add(new(-1, cpu.InstructionPointer, $"0x{cpu.InstructionPointer:X}"));
            foreach (var key in names.Distinct())
            {
                if (!t.Functions.TryGetValue(key, out var hits))
                {
                    if (t.Functions.Count >= 50_000) { truncated = true; continue; }
                    t.Functions[key] = hits = new();
                }
                hits.Inclusive++;
                if (key == names[0]) hits.Self++;
            }
            if (names.Count > 1)
            {
                var shown = names.Take(24).Reverse().Select(k => k.Name).ToArray();
                var chain = JsonSerializer.Serialize(shown);
                if (t.Stacks.TryGetValue(chain, out var current)) t.Stacks[chain] = (current.Frames, current.Samples + 1);
                else if (t.Stacks.Count < 2048) t.Stacks[chain] = (shown, 1);
            }
        }
        if (samples < 30) warnings.Add("所选区间样本较少；可合并相邻帧再分析。");
        if (stackSamples < samples) warnings.Add("部分样本没有调用栈，只统计采样地址。");
        if (log.EventsLost != 0) warnings.Add("ETL 有丢失事件，结果可能不完整。");
        if (truncated || threads.Count > 64) warnings.Add("统计结果已达到样本、函数或线程数量上限。");
        if (symbols.Matched == 0) warnings.Add("没有加载匹配的本地原生 PDB；未解析的地址显示模块及偏移。");
        else if (symbols.Unmatched.Count > 0) warnings.Add("部分模块没有匹配的 PDB，仍显示模块及偏移。");
        if (symbols.IndexIncomplete) warnings.Add("符号目录搜索不完整：有不可访问的子目录，或达到扫描上限。");
        var interval = log.SampleProfileInterval.TotalMilliseconds;
        return new
        {
            mainThreadId = EstimateMainThread(process),
            startMs = start, endMs = end, samples, stackSamples, warnings, matchedPdbs = symbols.Matched, matchedSymbolModules = symbols.MatchedNames, unmatchedSymbolModules = symbols.Unmatched,
            intervalMs = interval > 0 ? (double?)interval : null,
            threads = threads.OrderByDescending(kv => kv.Value.Samples).ThenBy(kv => kv.Key).Take(64).Select(kv => new
            {
                tid = kv.Key, samples = kv.Value.Samples,
                functions = kv.Value.Functions.OrderByDescending(f => f.Value.Inclusive).ThenByDescending(f => f.Value.Self).ThenBy(f => f.Key.Name, StringComparer.Ordinal).Take(40)
                    .UnionBy(kv.Value.Functions.OrderByDescending(f => f.Value.Self).ThenByDescending(f => f.Value.Inclusive).ThenBy(f => f.Key.Name, StringComparer.Ordinal).Take(40), f => f.Key)
                    .Select(f => new { name = f.Key.Name, inclusive = f.Value.Inclusive, self = f.Value.Self }).ToArray(),
                stacks = kv.Value.Stacks.Values.OrderByDescending(v => v.Samples).Take(3).Select(v => new { frames = v.Frames, samples = v.Samples }).ToArray()
            }).ToArray()
        };
    }

    private sealed class OfflineSymbols : IDisposable
    {
        private readonly TraceProcess process;
        private readonly string directory;
        private readonly List<SymbolReader> readers = new();
        private readonly Dictionary<int, NativeSymbolModule?> pdbs = new();
        private readonly Dictionary<(int, ulong), FunctionKey> locations = new();
        public int Matched => pdbs.Values.Count(p => p != null);
        public OfflineSymbols(TraceProcess p, string path)
        {
            process = p;
            directory = path;
        }
        public FunctionKey Resolve(TraceCodeAddress address, double time)
        {
            var module = address.ModuleFile;
            if (module == null) return new(-1, address.Address, $"0x{address.Address:X}");
            var id = (int)module.ModuleFileIndex;
            // TraceModuleFile.ImageBase is image-wide, not a per-process ASLR load address.
            var loaded = process.LoadedModules.GetModuleContainingAddress(address.Address, time);
            ulong imageBase = loaded?.ImageBase ?? module.ImageBase;
            ulong rva = address.Address >= imageBase ? address.Address - imageBase : address.Address;
            if (locations.TryGetValue((id, rva), out var cached)) return cached;
            var moduleName = Clip(address.ModuleName ?? "模块");
            FunctionKey key = new(id, rva, $"{moduleName}+0x{rva:X}");
            if (rva <= uint.MaxValue && TryPdb(id, module) is { } native)
            {
                try
                {
                    uint start = 0;
                    var name = native.FindNameForRva((uint)rva, ref start);
                    if (!string.IsNullOrEmpty(name)) key = new(id, start, $"{moduleName}!{Clip(name)}");
                }
                catch (System.Runtime.InteropServices.COMException) { }
            }
            if (locations.Count < 500_000) locations[(id, rva)] = key;
            return key;
        }
        private static string Clip(string s) => s.Length > 160 ? s[..160] : s;
        private readonly Dictionary<string, List<string>> candidates = new(StringComparer.OrdinalIgnoreCase);
        private readonly SortedSet<string> matchedNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly SortedSet<string> unmatchedNames = new(StringComparer.OrdinalIgnoreCase);
        private bool indexed;
        public bool IndexIncomplete { get; private set; }
        public string[] MatchedNames => matchedNames.Take(64).ToArray();
        public IReadOnlyList<string> Unmatched => unmatchedNames.Take(64).ToArray();

        private void Index()
        {
            if (indexed) return;
            indexed = true;
            var queue = new Queue<DirectoryInfo>();
            queue.Enqueue(new DirectoryInfo(directory));
            int entries = 0;
            while (queue.TryDequeue(out var dir))
            {
                try
                {
                    if (dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                    foreach (var entry in dir.EnumerateFileSystemInfos())
                    {
                        if (++entries > 100_000) { IndexIncomplete = true; return; }
                        var attributes = entry.Attributes;
                        if (attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                        if (entry is DirectoryInfo child) queue.Enqueue(child);
                        else if (entry.Extension.Equals(".pdb", StringComparison.OrdinalIgnoreCase))
                        {
                            if (!candidates.TryGetValue(entry.Name, out var files)) candidates[entry.Name] = files = new();
                            files.Add(entry.FullName);
                        }
                    }
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { IndexIncomplete = true; }
            }
        }
        private NativeSymbolModule? TryPdb(int moduleId, TraceModuleFile module)
        {
            if (directory.Length == 0) return null;
            if (pdbs.TryGetValue(moduleId, out var existing)) return existing;
            NativeSymbolModule? match = null;
            var name = Path.GetFileName(module.PdbName ?? "");
            if (module.PdbSignature != Guid.Empty && name.Length > 0 && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && Path.GetExtension(name).Equals(".pdb", StringComparison.OrdinalIgnoreCase))
            {
                Index();
                if (candidates.TryGetValue(name, out var files))
                    foreach (var file in files)
                    {
                        if (readers.Count >= 256) { IndexIncomplete = true; break; }
                        SymbolReader? reader = null;
                        try
                        {
                            if (File.GetAttributes(file).HasFlag(FileAttributes.ReparsePoint)) continue;
                            // Keep each successful DIA module in a dedicated reader so cache eviction cannot invalidate it.
                            reader = new SymbolReader(TextWriter.Null, directory) { Options = SymbolReaderOptions.CacheOnly };
                            var opened = reader.OpenNativeSymbolFile(file);
                            if (opened != null && opened.PdbGuid == module.PdbSignature && opened.PdbAge == module.PdbAge)
                            {
                                match = opened;
                                readers.Add(reader);
                                reader = null;
                                break;
                            }
                        }
                        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException) { }
                        finally { reader?.Dispose(); }
                    }
            }
            if (match != null) matchedNames.Add(Clip(name));
            else if (name.Length > 0) unmatchedNames.Add(Clip(name));
            pdbs[moduleId] = match;
            return match;
        }
        public void Dispose()
        {
            foreach (var reader in readers) reader.Dispose();
        }
    }
}
