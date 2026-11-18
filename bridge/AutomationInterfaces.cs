namespace Dsh.VisualStudio.Bridge;
// Official Microsoft.VisualStudio.Interop 17.14.40260 defines complete dual COM
// vtables; do not invoke selected derived members through a partial interface.
internal static class ExtendedAutomation {
 internal static object Raw(object value)=>value is ComDispatch wrapped?wrapped.Value:value;
 internal static object? Position(object frame){
  if (Raw(frame) is not EnvDTE90a.StackFrame2 typed) return null;
  return new {file=typed.FileName,line=(int)typed.LineNumber};
 }
}
