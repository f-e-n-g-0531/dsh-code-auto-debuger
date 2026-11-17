using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
namespace Dsh.VisualStudio.Bridge;
internal static class InstalledInterop {
 [ModuleInitializer] internal static void Initialize(){AssemblyLoadContext.Default.Resolving += Resolve;}
 private static Assembly? Resolve(AssemblyLoadContext context,AssemblyName name){
  if(name.Name!="Microsoft.VisualStudio.Interop")return null;
  // Use only Microsoft's installed VS prerequisite, not current directory or
  // arbitrary model input. Never redistribute restricted SDK assemblies.
  foreach(var root in new[]{Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)})
   foreach(var edition in new[]{"Community","Professional","Enterprise","BuildTools"}){
    var file=Path.Combine(root,"Microsoft Visual Studio","2022",edition,"Common7","IDE","PublicAssemblies","Microsoft.VisualStudio.Interop.dll");
    if(File.Exists(file)){var identity=AssemblyName.GetAssemblyName(file);if(identity.Name==name.Name && (name.Version is null || identity.Version is not null && identity.Version>=name.Version) && string.Equals(identity.CultureName??"",name.CultureName??"",StringComparison.OrdinalIgnoreCase) && Convert.ToHexString(identity.GetPublicKeyToken()??[])=="B03F5F7F11D50A3A")return context.LoadFromAssemblyPath(file);}
   }
  return null;
 }
}
