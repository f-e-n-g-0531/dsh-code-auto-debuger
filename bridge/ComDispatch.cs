using System.Dynamic;
using System.Reflection;

namespace Dsh.VisualStudio.Bridge;

// .NET's C# COM binder may require unavailable VS interop type libraries even
// for IDispatch members. Reflection invokes IDispatch directly, without PIAs.
internal sealed class ComDispatch(object value) : DynamicObject
{
    internal object Value { get; } = value is ComDispatch wrapped ? wrapped.Value : value;
    private object? Invoke(string name, BindingFlags flags, object?[]? args)
    {
        try {
            return Value.GetType().InvokeMember(name, flags, null, Value, args);
        }
        catch (TargetInvocationException e) when (e.InnerException != null)
        { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw(); throw; }
    }
    public override bool TryGetMember(GetMemberBinder binder, out object? result)
    { result = Invoke(binder.Name, BindingFlags.GetProperty, null); return true; }
    public override bool TryInvokeMember(InvokeMemberBinder binder, object?[]? args, out object? result)
    { result = Invoke(binder.Name, BindingFlags.InvokeMethod | BindingFlags.GetProperty | BindingFlags.OptionalParamBinding, args); return true; }
}
