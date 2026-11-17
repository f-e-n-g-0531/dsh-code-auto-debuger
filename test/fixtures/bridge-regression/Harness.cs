using System.Runtime.InteropServices;
using System.Text.Json;
namespace Dsh.VisualStudio.Bridge;
public sealed class ObservationFailure
{
    public object Children => throw new COMException("busy", unchecked((int)0x8001010A));
    public int Type => throw new COMException("type unavailable");
}
public sealed class TypeObservationFailure
{
    public object Children => new EmptyChildren();
    public int Type => throw new COMException("type unavailable");
}
public sealed class EmptyChildren { public int Count => 0; }
public sealed class CreatedBreakpoint { public int Deleted; public object Children => new EmptyChildren(); public int Type => 2; public void Delete() { Deleted++; } }
public sealed class FailingCreationCollection
{
    public bool CountBusy; public bool ItemBusy; public int ItemCalls; public CreatedBreakpoint Created = new();
    public int Count => CountBusy ? throw new COMException("Count busy") : 1;
    public object Item(int index) { ItemCalls++; if(ItemBusy) throw new COMException("Item busy"); return Created; }
}
internal static class Harness
{
    public static void Main()
    {
        using var scope = new ComScope();
        var value = JsonSerializer.SerializeToElement(VisualStudioSession.ObserveCreatedBreakpoint("created-id", new ObservationFailure(), scope));
        if (value.GetProperty("breakpointId").GetString() != "created-id" || !value.GetProperty("created").GetBoolean() || value.GetProperty("bound").ValueKind != JsonValueKind.Null || value.GetProperty("observationError").GetString() == null) throw new Exception("Partial add lost identity");
        var typeFailure = JsonSerializer.SerializeToElement(VisualStudioSession.ObserveCreatedBreakpoint("type-id", new TypeObservationFailure(), scope));
        if (typeFailure.GetProperty("breakpointId").GetString() != "type-id" || typeFailure.GetProperty("bound").ValueKind != JsonValueKind.Null) throw new Exception("Type failure lost identity");
        if (new NoRetryFilter().RetryRejectedCall(0,0,2) != -1) throw new Exception("Busy replay allowed");
        foreach(bool failCount in new[]{true,false})
        {
            var returned = new FailingCreationCollection { CountBusy = failCount, ItemBusy = !failCount };
            using var creation = new OwnedBreakpointCreation(returned);
            var pending = JsonSerializer.SerializeToElement(creation.Observe("opaque-id"));
            if(pending.GetProperty("breakpointId").GetString() != "opaque-id" || !pending.GetProperty("pendingCreation").GetBoolean()) throw new Exception("Pending creation lost ID");
            returned.CountBusy=false; returned.ItemBusy=false;
            var recovered = JsonSerializer.SerializeToElement(creation.Observe("opaque-id"));
            if(!recovered.GetProperty("bound").GetBoolean()) throw new Exception("Read-only resolve failed");
            creation.DeleteExact();
            if(returned.Created.Deleted != 1) throw new Exception("Exact creation remove failed");
        }
        // Arbitrary matching test GUID, not a claimed built-in transport GUID.
        const string transportId = "{11111111-2222-3333-4444-555555555555}";
        foreach(var qualifier in new[]{"", ".", Environment.MachineName, "localhost", "127.0.0.1", "::1"}) VisualStudioSession.RequireLocalTransport(transportId, transportId, qualifier);
        foreach(var qualifier in new[]{"other-machine", "192.0.2.10", Environment.MachineName + ":4026"})
        {
            try { VisualStudioSession.RequireLocalTransport(transportId, transportId, qualifier); throw new Exception("Remote accepted"); }
            catch(BridgeError e) when(e.Code == "LOCALITY_UNVERIFIED") { }
        }
        try { VisualStudioSession.RequireLocalTransport(transportId, Guid.NewGuid().ToString(), ""); throw new Exception("Nonlocal transport accepted"); }
        catch(BridgeError e) when(e.Code == "LOCALITY_UNVERIFIED") { }
        if(!VisualStudioSession.IsBusy(new COMException("busy", unchecked((int)0x8001010A)))) throw new Exception("Busy misclassified");
        Console.WriteLine("PASS Count/Item/Children/Type recovery, exact remove, local transport/qualifier remote gates and busy no-replay");
    }
}
