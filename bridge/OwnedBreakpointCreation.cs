namespace Dsh.VisualStudio.Bridge;
// A returned collection is already evidence of creation, even when VS rejects
// the next Count/Item observation. Its opaque ID survives those failures.
internal sealed class OwnedBreakpointCreation(object returnedCollection) : IDisposable
{
    private readonly object collection = returnedCollection;
    private object? breakpoint;
    private object Resolve()
    {
        if (breakpoint != null) return breakpoint;
        dynamic exact = new ComDispatch(collection);
        int count = collection is EnvDTE.Breakpoints typed ? typed.Count : (int)exact.Count;
        if (count != 1) throw new BridgeError("OUTCOME_UNKNOWN", "Returned creation collection does not contain exactly one breakpoint; inspect without repeating Add");
        breakpoint = collection is EnvDTE.Breakpoints typedItems ? typedItems.Item(1) : exact.Item(1);
        return breakpoint;
    }
    public object Observe(string id)
    {
        object resolved;
        try { resolved = Resolve(); }
        catch (Exception)
        {
            return new { breakpointId = id, created = true, pendingCreation = true, bound = (bool?)null, observationError = "Creation collection retained; Count/Item unavailable. Query listOwnedBreakpoints; do not repeat Add" };
        }
        using var scope = new ComScope();
        return VisualStudioSession.ObserveCreatedBreakpoint(id, resolved, scope);
    }
    public void DeleteExact()
    {
        // Resolve only this Add return; never enumerate the global breakpoint list.
        ((dynamic)new ComDispatch(Resolve())).Delete();
    }
    public void Dispose() { Native.Release(breakpoint); Native.Release(collection); }
}
