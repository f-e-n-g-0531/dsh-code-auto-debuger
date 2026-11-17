using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Dsh.VisualStudio.Bridge;

internal sealed record Debuggee(int processId, string startTime);

internal sealed record Target(string instanceId, int pid, string startTime, string solutionPath, string version);

internal sealed class ComScope : IDisposable
{
    private readonly List<object> values = [];
    public dynamic Hold(object value) { if (value is ComDispatch wrapped) value = wrapped.Value; if (Marshal.IsComObject(value)) values.Add(value); return new ComDispatch(value); }
    public void Dispose() { for (int i = values.Count - 1; i >= 0; --i) Native.Release(values[i]); }
}

internal sealed class VisualStudioSession : IDisposable
{
    private object? dte;
    private Target? target;
    private readonly Dictionary<string, OwnedBreakpointCreation> breakpoints = new(StringComparer.Ordinal);
    private string lastState = "disconnected";
    private string? stopId;
    private readonly Dictionary<int, string> ownedProcesses = [];
        private static string ProcessStart(int pid)
    { using var process = Process.GetProcessById(pid); return process.StartTime.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture); }
    private List<Debuggee> Debuggees(dynamic debugger, ComScope scope)
    {
        var result = new List<Debuggee>();
        dynamic processes = scope.Hold(debugger.DebuggedProcesses);
        int count = (int)processes.Count;
        if (count > 128) throw new BridgeError("LIMIT_EXCEEDED", "Too many debuggees");
        for (int i = 1; i <= count; ++i)
        {
            dynamic process = scope.Hold(processes.Item(i));
            // Prove membership by COM identity, never map a possibly remote PID
            // onto an unrelated local process with the same numeric ID.
            try { RequireLocalProcess(debugger, process, scope); }
            catch (BridgeError) { throw; }
            catch (COMException e) when (IsBusy(e)) { throw; }
            catch (Exception e) { throw new BridgeError("LOCALITY_UNVERIFIED", "Local process API unavailable (" + e.GetType().Name + (e is System.IO.FileNotFoundException missing ? ":"+missing.FileName : "") + ", HRESULT=" + e.HResult.ToString("X8", CultureInfo.InvariantCulture) + "); no local PID mapping performed"); }
            int pid = (int)process.ProcessID;
            result.Add(new Debuggee(pid, ProcessStart(pid)));
        }
        return result;
    }
    internal static void RequireLocalProcess(dynamic debugger, dynamic process, ComScope scope)
    {
        // Microsoft Debugger2.Transports remarks: Item(1) is always Default,
        // used locally BUT ALSO remotely. Therefore its ID alone is insufficient.
        // https://learn.microsoft.com/en-us/dotnet/api/envdte80.debugger2.transports
        string stage = "debugger.transports";
        try {
          var dbg = (EnvDTE80.Debugger2)ExtendedAutomation.Raw((object)debugger);
          var proc = (EnvDTE80.Process2)ExtendedAutomation.Raw((object)process);
          stage = "transports.item"; var transports = dbg.Transports; scope.Hold((object)transports); var localTransport = transports.Item(1); scope.Hold((object)localTransport);
          stage = "process.transport"; var transport = proc.Transport; scope.Hold((object)transport);
          stage = "transport.id"; string expected=localTransport.ID; string actual=transport.ID;
          stage = "process.qualifier"; string qualifier=proc.TransportQualifier;
          RequireLocalTransport(expected,actual,qualifier);
        } catch(COMException e) when(!IsBusy(e)) { throw new BridgeError("LOCALITY_UNVERIFIED", "Locality stage " + stage + " HRESULT=" + e.HResult.ToString("X8",CultureInfo.InvariantCulture) + "; no local PID mapping performed"); }
    }
    internal static void RequireLocalTransport(string expected, string actual, string qualifier)
    {
        if (!Guid.TryParse(expected, out var local) || !Guid.TryParse(actual, out var transport) || local != transport)
            throw new BridgeError("LOCALITY_UNVERIFIED", "Debuggee transport is not the DTE default transport; no local PID mapping performed");
        // Empty/default transport is local. Explicit qualifiers must identify
        // this machine, never an arbitrary remote host or machine:port endpoint.
        if (qualifier.Length != 0 && qualifier != "." &&
            !string.Equals(qualifier, Environment.MachineName, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(qualifier, "localhost", StringComparison.OrdinalIgnoreCase) &&
            qualifier is not ("127.0.0.1" or "::1"))
            throw new BridgeError("LOCALITY_UNVERIFIED", "Debuggee transport qualifier is not this local machine; no local PID mapping performed");
    }
    internal static bool IsBusy(COMException e) => e.HResult is unchecked((int)0x80010001) or unchecked((int)0x8001010A);
    private void RequireOwned(List<Debuggee> processes)
    {
        if (processes.Count == 0 || processes.Any(p => !ownedProcesses.TryGetValue(p.processId, out var start) || start != p.startTime))
            throw new BridgeError("NOT_OWNED", "Debuggee identity is not owned by this bridge connection");
    }
    private static readonly Regex MonikerPattern = new(@"^!VisualStudio\.DTE\.[0-9]+\.[0-9]+:([0-9]+)$", RegexOptions.CultureInvariant);

    private static string Canonical(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new BridgeError("INVALID_REQUEST", "An absolute path is required");
        return Path.GetFullPath(path);
    }
    private static string Clip(object? value, int max = 2048)
    {
        var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        return text.Length <= max ? text : text[..max];
    }
    private static Target Describe(string moniker, int pid, dynamic automation)
    {
        using var process = Process.GetProcessById(pid);
        if (!string.Equals(process.ProcessName, "devenv", StringComparison.OrdinalIgnoreCase))
            throw new BridgeError("TARGET_MISMATCH", "ROT PID is not devenv");
        using var scope = new ComScope();
        dynamic window = scope.Hold(automation.MainWindow);
        Native.GetWindowThreadProcessId(new nint((long)window.HWnd), out uint windowPid);
        if (windowPid != pid) throw new BridgeError("TARGET_MISMATCH", "ROT PID and DTE window PID differ");
        dynamic solution = scope.Hold(automation.Solution);
        string solutionPath = Clip(solution.FullName, 32768);
        if (solutionPath.Length > 0) solutionPath = Canonical(solutionPath);
        var started = process.StartTime.ToUniversalTime();
        return new Target(moniker + "@" + started.Ticks.ToString(CultureInfo.InvariantCulture), pid,
            started.ToString("O", CultureInfo.InvariantCulture), solutionPath, Clip(automation.Version));
    }

    private static List<Target> Enumerate(string? requested, out object? selected)
    {
        selected = null;
        var results = new List<Target>();
        Marshal.ThrowExceptionForHR(Native.GetRunningObjectTable(0, out var rot));
        IBindCtx? context = null;
        IEnumMoniker? enumerator = null;
        try
        {
            Marshal.ThrowExceptionForHR(Native.CreateBindCtx(0, out context));
            rot.EnumRunning(out enumerator);
            var item = new IMoniker[1];
            int scanned = 0;
            while (results.Count < 64 && scanned++ < 4096 && enumerator.Next(1, item, 0) == 0)
            {
                object? candidate = null;
                try
                {
                    item[0].GetDisplayName(context, null, out var name);
                    var match = MonikerPattern.Match(name);
                    if (!match.Success || !int.TryParse(match.Groups[1].Value, out int pid)) continue;
                    rot.GetObject(item[0], out candidate);
                    var identity = Describe(name, pid, new ComDispatch(candidate));
                    results.Add(identity);
                    if (identity.instanceId == requested) { selected = candidate; candidate = null; break; }
                }
                catch (Exception e) when (e is COMException or ArgumentException or InvalidOperationException or BridgeError)
                { /* inaccessible, busy or stale ROT entries are not usable instances */ }
                finally { Native.Release(candidate); Native.Release(item[0]); }
            }
        }
        finally { Native.Release(enumerator); Native.Release(context); Native.Release(rot); }
        return results;
    }

    private dynamic Validate()
    {
        if (dte == null || target == null) throw new BridgeError("DISCONNECTED", "Connect an exact discovered target first");
        var moniker = target.instanceId[..target.instanceId.LastIndexOf('@')];
        Target current;
        try { current = Describe(moniker, target.pid, new ComDispatch(dte)); }
        catch (COMException) { throw; }
        catch { Dispose(); throw new BridgeError("TARGET_MISMATCH", "Bound Visual Studio process identity is no longer valid"); }
        if (current != target)
        {
            Dispose();
            throw new BridgeError("TARGET_MISMATCH", "Bound process, solution or version changed; reconnect explicitly");
        }
        return new ComDispatch(dte);
    }

    private string State(dynamic debugger)
    {
        string state = (int)debugger.CurrentMode switch { 1 => "design", 2 => "break", 3 => "running", _ => "disconnected" };
        if (state == "break" && lastState != "break") stopId = Guid.NewGuid().ToString("N");
        if (state != "break") stopId = null;
        lastState = state;
        return state;
    }
    private static void Require(string state, params string[] permitted)
    {
        if (!permitted.Contains(state)) throw new BridgeError("INVALID_STATE", "Command is not valid in " + state);
    }
    public object Execute(Request request)
    {
        var p = request.Parameters;
        switch (request.Method)
        {
            case "processDescribe":
                Protocol.Fields(p, "processId");
                int processId = Protocol.PositiveInt(p, "processId");
                return new Debuggee(processId, ProcessStart(processId));
            case "discover": Protocol.Fields(p); return new { instances = Enumerate(null, out _) };
            case "disconnect": Protocol.Fields(p); Dispose(); return new { state = "disconnected", target = (Target?)null };
            case "connect":
                Protocol.Fields(p, "instanceId", "solutionPath");
                string instance = Protocol.Text(p, "instanceId");
                string solution = Canonical(Protocol.Text(p, "solutionPath", 32768));
                Enumerate(instance, out var found);
                if (found == null) throw new BridgeError("TARGET_NOT_FOUND", "Exact ROT instance and process start identity not found");
                try
                {
                    var split = instance.LastIndexOf('@');
                    var match = MonikerPattern.Match(instance[..split]);
                    var identity = Describe(instance[..split], int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture), new ComDispatch(found));
                    if (!string.Equals(solution, identity.solutionPath, StringComparison.OrdinalIgnoreCase))
                        throw new BridgeError("TARGET_MISMATCH", "solutionPath does not match selected instance");
                    Dispose(); dte = found; found = null; target = identity;
                    using var scope = new ComScope();
                    return new { target, state = State(scope.Hold(((dynamic)new ComDispatch(dte)).Debugger)) };
                }
                finally { Native.Release(found); }
            case "status":
                Protocol.Fields(p);
                if (dte == null) return new { state = "disconnected", target = (Target?)null, debuggees = new List<Debuggee>() };
                using (var scope = new ComScope())
                {
                    dynamic debugger = scope.Hold(Validate().Debugger);
                    return new { state = State(debugger), target, debuggees = Debuggees(debugger, scope) };
                }
            case "listOwnedBreakpoints": Protocol.Fields(p); return new { breakpoints = breakpoints.Select(pair => pair.Value.Observe(pair.Key)).ToArray() };
            case "snapshot": Protocol.Fields(p); return Snapshot();
            case "evaluate": Protocol.Fields(p, "expression"); break;
            case "breakpointAdd": Protocol.Fields(p, "file", "line"); break;
            case "breakpointRemove": Protocol.Fields(p, "breakpointId"); break;
            case "attach": Protocol.Fields(p, "processId", "expectedStartTime"); break;
            case "step": Protocol.Fields(p, "kind"); break;
            case "launch": case "continue": case "pause": case "detach": case "terminate": Protocol.Fields(p); break;
            default: throw new BridgeError("UNKNOWN_METHOD", "Unknown method");
        }
        return Command(request.Method, p);
    }

    private object Command(string method, JsonElement p)
    {
        using var scope = new ComScope();
        dynamic automation = Validate();
        dynamic debugger = scope.Hold(automation.Debugger);
        string state = State(debugger);
        if (state is "break" or "running") _ = Debuggees(debugger, scope);
        switch (method)
        {
            case "evaluate":
                string expression = Protocol.Text(p, "expression", 4096);
                Require(state, "break");
                dynamic value = scope.Hold(debugger.GetExpression(expression, false, 1000));
                return new { expression, valid = (bool)value.IsValidValue, type = Clip(value.Type), value = Clip(value.Value, 8192), risky = true };
            case "breakpointAdd":
                string file = Canonical(Protocol.Text(p, "file", 32768));
                int line = Protocol.PositiveInt(p, "line");
                dynamic collection = scope.Hold(debugger.Breakpoints);
                // Retain the exact Add return before any Count/Item COM observation.
                object added = collection.Add("", file, line, 1, "", 1, "", "", 1, "", 0, 1);
                string id = Guid.NewGuid().ToString("N");
                var creation = new OwnedBreakpointCreation(added);
                breakpoints.Add(id, creation);
                return creation.Observe(id);
            case "breakpointRemove":
                string breakpointId = Protocol.Text(p, "breakpointId", 64);
                if (!breakpoints.TryGetValue(breakpointId, out var owned)) throw new BridgeError("NOT_OWNED", "Only breakpoints created by this connection may be removed");
                owned.DeleteExact();
                breakpoints.Remove(breakpointId); owned.Dispose();
                break;
            case "launch":
                Require(state, "design");
                if (Debuggees(debugger, scope).Count != 0) throw new BridgeError("NOT_OWNED", "Launch requires no existing debuggees");
                debugger.Go(false);
                // Go already returned: capture is a separate observation, not a
                // failed/retryable launch. Never grant partial destructive ownership.
                lastState = "unknown"; stopId = null;
                try
                {
                    var captured = Debuggees(debugger, scope);
                    foreach (var process in captured) ownedProcesses[process.processId] = process.startTime;
                    return new { accepted = true, outcome = "command_returned", target, ownershipCaptured = captured.Count > 0, observationError = (string?)null };
                }
                catch (Exception e)
                {
                    ownedProcesses.Clear();
                    string code = e is COMException com && IsBusy(com) ? "BUSY" : e is BridgeError error ? error.Code : "OBSERVATION_ERROR";
                    return new { accepted = true, outcome = "command_returned", target, ownershipCaptured = false, observationError = code + ": launch returned but ownership capture failed; inspect status, do not repeat launch" };
                }
            case "continue": Require(state, "break"); debugger.Go(false); break;
            case "pause": Require(state, "running"); debugger.Break(false); break;
            case "step":
                string kind = Protocol.Text(p, "kind", 8);
                if (kind is not ("into" or "over" or "out")) throw new BridgeError("INVALID_REQUEST", "kind must be into, over or out");
                Require(state, "break");
                if (kind == "into") debugger.StepInto(false);
                else if (kind == "over") debugger.StepOver(false);
                else debugger.StepOut(false);
                break;
            case "attach":
                int pid = Protocol.PositiveInt(p, "processId");
                string expectedStartTime = Protocol.Text(p, "expectedStartTime", 64);
                if (ProcessStart(pid) != expectedStartTime) throw new BridgeError("TARGET_MISMATCH", "Attach process differs from preview identity");
                Require(state, "design");
                if (pid == target!.pid || pid == Environment.ProcessId) throw new BridgeError("INVALID_REQUEST", "Cannot attach to VS or bridge itself");
                using (var process = Process.GetProcessById(pid))
                {
                    long ticks = process.StartTime.ToUniversalTime().Ticks;
                    dynamic local = scope.Hold(debugger.LocalProcesses);
                    object? selected = null;
                    for (int i = 1; i <= (int)local.Count; ++i)
                    {
                        dynamic candidate = scope.Hold(local.Item(i));
                        if ((int)candidate.ProcessID == pid) { selected = candidate; break; }
                    }
                    if (selected == null) throw new BridgeError("PROCESS_NOT_FOUND", "Requested local process is not attachable");
                    using var check = Process.GetProcessById(pid);
                    if (check.StartTime.ToUniversalTime().Ticks != ticks) throw new BridgeError("TARGET_MISMATCH", "Attach process identity changed");
                    Validate();
                    if (ProcessStart(pid) != expectedStartTime) throw new BridgeError("TARGET_MISMATCH", "Attach process changed");
                    ((dynamic)selected).Attach();
                    ownedProcesses[pid] = expectedStartTime;
                }
                break;
            case "detach":
                Require(state, "running", "break"); RequireOwned(Debuggees(debugger, scope));
                Validate(); debugger.DetachAll(); ownedProcesses.Clear(); break;
            case "terminate":
                Require(state, "running", "break"); RequireOwned(Debuggees(debugger, scope));
                Validate(); debugger.Stop(false); ownedProcesses.Clear(); break;
        }
        // Invalidate the observed stop on every execution-changing command.
        if (method is not ("breakpointAdd" or "breakpointRemove")) { lastState = "unknown"; stopId = null; }
        return new { accepted = true, outcome = "command_returned", target };
    }

    internal static object ObserveCreatedBreakpoint(string id, object bp, ComScope scope)
    {
                // DTE 1 = pending, 2 = bound. A pending parent may own bound children.
                try
                {
                    dynamic children = scope.Hold(((dynamic)new ComDispatch(bp)).Children);
                    return new { breakpointId = id, created = true, bound = (bool?)((int)((dynamic)new ComDispatch(bp)).Type == 2 || (int)children.Count > 0), observationError = (string?)null };
                }
                catch (Exception)
                {
                    // Add already succeeded. Preserve its ID and forbid callers from
                    // treating a subsequent observational COM failure as a failed add.
                    return new { breakpointId = id, created = true, bound = (bool?)null, observationError = "Bound state unavailable; inspect listOwnedBreakpoints, do not repeat add" };
                }
    }

    private object Snapshot()
    {
        using var scope = new ComScope();
        dynamic debugger = scope.Hold(Validate().Debugger);
        string state = State(debugger);
        if (state is "break" or "running") _ = Debuggees(debugger, scope);
        // Do not reuse identity across observations: VS may have resumed and
        // stopped through its UI between requests without an observed transition.
        if (state == "break") stopId = Guid.NewGuid().ToString("N");
        var threads = new List<object>(); var stack = new List<object>();
        object? position = null;
        bool truncated = false;
        if (state == "break")
        {
            dynamic program = scope.Hold(debugger.CurrentProgram);
            dynamic allThreads = scope.Hold(program.Threads);
            int threadCount = (int)allThreads.Count;
            truncated = threadCount > 64;
            for (int i = 1; i <= Math.Min(threadCount, 64); ++i)
            {
                dynamic thread = scope.Hold(allThreads.Item(i));
                threads.Add(new { id = (int)thread.ID, name = Clip(thread.Name, 256) });
            }
            dynamic current = scope.Hold(debugger.CurrentThread);
            dynamic frames = scope.Hold(current.StackFrames);
            int count = (int)frames.Count;
            truncated |= count > 64;
            for (int i = 1; i <= Math.Min(count, 64); ++i)
            {
                dynamic frame = scope.Hold(frames.Item(i));
                stack.Add(new { index = i - 1, function = Clip(frame.FunctionName), module = Clip(frame.Module), language = Clip(frame.Language, 256) });
            }
            // File/line are optional: not all engines expose StackFrame2 location.
            try
            {
                dynamic frame = scope.Hold(debugger.CurrentStackFrame);
                position = ExtendedAutomation.Position((object)frame);
            }
            catch (Exception e) when (e is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
        }
        return new { state, target, stopId, stopIdentity = "snapshot-observation", position, threads, stack, truncated, variablesEvaluated = false };
    }

    public void Dispose()
    {
        // Release ownership only. Never Delete user breakpoints, Quit VS, detach,
        // or stop debuggees as an implicit consequence of transport shutdown.
        foreach (var bp in breakpoints.Values) bp.Dispose();
        breakpoints.Clear(); Native.Release(dte); dte = null; target = null;
        lastState = "disconnected"; stopId = null; ownedProcesses.Clear();
    }
}
