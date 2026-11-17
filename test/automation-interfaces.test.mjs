import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("extended automation uses fixed official complete dual interfaces without redistributed SDK assemblies", async () => {
  const source = await readFile("bridge/AutomationInterfaces.cs", "utf8"),
    project = await readFile("bridge/Dsh.VisualStudio.Bridge.csproj", "utf8");
  assert(source.includes("EnvDTE90a.StackFrame2"));
  assert(project.includes("Microsoft.VisualStudio.Interop"));
  assert(project.includes("17.14.40260"));
  assert(!source.includes("GetDelegateForFunctionPointer"));
});
