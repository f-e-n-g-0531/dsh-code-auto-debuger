# External Visual Studio COM bridge

Windows x64 console. Building requires the .NET 8 SDK; the distributed bridge is self-contained. No VSIX, installer or registry changes. Official Microsoft.VisualStudio.Interop 17.14.40260 definitions are a build-time dependency and runtime resolution from the installed VS 2022 PublicAssemblies prerequisite; SDK DLLs are not redistributed. Uses dynamic COM against an already-running interactive Visual Studio instance with matching privilege level.

## Build

```powershell
npm run build:bridge
```

From the repository root, this creates `dist/bridge/win-x64/dsh-vs-bridge.exe`. Do not install or auto-start Visual Studio. Start the bridge only through an authorized owner; stdin grants full capabilities on the explicitly selected instance, not an authentication boundary.

## JSONL protocol 1

UTF-8 stdin requests: {"protocol":1,"id":"unique-owner-id","method":"status","params":{}}. stdout contains only {"protocol":1,"id":...,"ok":true,"value":...} or {"protocol":1,"id":...,"ok":false,"error":{"code":"...","message":"..."}}. Diagnostics go to stderr. One request at a time. IDs correlate only: they are **not** idempotency keys and must not be replayed after transport loss.

Malformed envelopes return id:null. Unknown/duplicate fields, unknown methods, invalid UTF-8, depth >16 and input records >65,536 bytes are rejected; oversized records are drained to the next newline. No arbitrary ExecuteCommand or shell method exists.

| Method | Exact params | Value |
|---|---|---|
| discover | {} | {instances:[{instanceId,pid,startTime,solutionPath,version}]} |
| connect | {instanceId,solutionPath} | {target,state} |
| disconnect | {} | {state:"disconnected",target:null} |
| status | {} | {state,target,debuggees:[{processId,startTime}]} |
| processDescribe | {processId} | {processId,startTime} |
| snapshot | {} | {state,target,stopId,stopIdentity,position,threads,stack,truncated,variablesEvaluated:false} |
| evaluate | {expression} | {expression,valid,type,value,risky:true} |
| breakpointAdd | {file,line} | {created:true,breakpointId,bound:boolean or null,pendingCreation?,observationError?} |
| listOwnedBreakpoints | {} | {breakpoints:[creation observations]} |
| breakpointRemove | {breakpointId} | command result |
| launch, continue, pause, detach, terminate | {} | command result |
| attach | {processId,expectedStartTime} | command result |
| step | {kind:"into" or "over" or "out"} | command result |

Command result: {accepted:true,outcome:"command_returned",target}. This records DTE return, **not** completion of asynchronous debugging work. Poll status explicitly. States: design/running/break/disconnected. launch requires design, continue/step/evaluate require break, pause requires running, attach requires design, detach/terminate require running or break. terminate stops debuggees, never Visual Studio.

## Target and ownership safety

Discover examines ROT monikers matching exact !VisualStudio.DTE.major.minor:PID, verifies devenv process and DTE window PID, and adds UTC process-start ticks to instanceId to defend PID reuse. Up to 64 usable entries are returned; inaccessible/stale entries are skipped. No first-instance fallback. Connect requires that opaque ID plus the explicit absolute solution path; empty solutions cannot be bound. Every command rechecks process identity, solution and VS version; mismatch drops the connection. Changes made by a person concurrently with a COM call cannot be made atomic; use a dedicated test VS instance and do not interact with its debugger concurrently.

Breakpoints have opaque IDs owned only in the current connection. Remove cannot enumerate/delete other breakpoints. Disconnect/EOF only release COM references; they do not delete breakpoints, detach/stop targets, close solutions or quit VS. Created breakpoints remain in VS after disconnect; inspect and remove manually if connection ownership is lost. Attach requires expectedStartTime from processDescribe, compared exactly as UTC O format both before selection and immediately before invoking Attach; no remote attach support. status exposes the current debuggee identity set for parent preview/execution binding. detach/terminate refuse unless the entire debuggee identity set is owned by a successful attach or captured immediately after launch returns. If asynchronous launch has not exposed processes on return, ownership is intentionally not inferred from later polls; detach/terminate will refuse. Use an explicit attach workflow when deterministic ownership is needed. There is no atomicity against concurrent debugger UI changes.

COM work is serialized on an STA with a Win32 message pump and no-retry OLE message filter. Busy calls return BUSY with no automatic mutation retry. Any COM failure may leave an unknown mutation outcome. A call exceeding 30 seconds causes bridge exit code 3 with no synthetic success and no replay; owner must inspect external state. The bridge never attempts to kill VS. Normal errors do not echo expressions or COM message details into diagnostic logs.

## Snapshot versus evaluation

Snapshot reads metadata only: at most 64 threads and 64 current-thread frames; bounded names; optional source position. It never enumerates locals, arguments, properties, expression values or evaluates a watch. Position may be null if the debugger engine does not expose file/line. Stack is current thread only. stopId is a fresh **snapshot observation token**, not a VS event sequence or proof that two polls refer to the same stop (UI resume/rebreak can occur between polls). stopIdentity is snapshot-observation. Evaluate alone invokes GetExpression, at break, with a 1,000ms debugger evaluation timeout and output clipped to 8,192 characters. Evaluation can call functions/change state; authorization and risk disclosure must occur in the parent before sending it.

## Fixtures and acceptance

Run [ProtocolSmoke.ps1](<ProtocolSmoke.ps1>) after building for disconnected-only framing/validation/EOF tests; it deliberately never calls discover/connect. API signatures and constants are checked against Microsoft Learn: [Breakpoints.Add](https://learn.microsoft.com/en-us/dotnet/api/envdte.breakpoints.add?view=visualstudiosdk-2022), [breakpoint types](https://learn.microsoft.com/en-us/dotnet/api/envdte.dbgbreakpointtype?view=visualstudiosdk-2022), [GetExpression](https://learn.microsoft.com/en-us/dotnet/api/envdte.debugger.getexpression?view=visualstudiosdk-2022), [StackFrame2](https://learn.microsoft.com/en-us/dotnet/api/envdte90a.stackframe2?view=visualstudiosdk-2022). This is documentation evidence, not live COM verification.

[C# fixture](<../test/fixtures/csharp/Program.cs>) and [C++ fixture](<../test/fixtures/cpp/main.cpp>) provide stable breakpoint markers. C# RiskyValue increments a counter if explicitly evaluated; snapshot must not touch it. Build C# with dotnet build test/fixtures/csharp/DebugFixture.csproj -c Debug. Generate C++ with cmake -S test/fixtures/cpp -B test/fixtures/cpp/build -G "Visual Studio 17 2022" -A x64, then cmake --build test/fixtures/cpp/build --config Debug. Fixtures must run only in a dedicated, authorized interactive test session.

[IntegrationSmoke.ps1](<IntegrationSmoke.ps1>) requires explicit -AllowNewVisualStudioFixture and starts/tracks/cleans only its new fixture VS PID. Live attempt on this machine was blocked by the modal “评审项目和解决方案更改” reporting unsupported projects or changes required. Discovery received RPC_E_CALL_REJECTED while the modal was open. No debug mutations completed; the modal was not accepted and all test-owned VS PIDs were cleaned. The original C# dynamic COM binder also failed on MainWindow; direct IDispatch reflection now avoids that typelib-dependent binding, successful native live property/debugger calls were subsequently verified as recorded below; C# live loading remains unverified.

### Native live evidence (2026-11-14)

Installed VC.Tools.x86.x64 was confirmed with vswhere; native CMake fixture built with MSVC19.44 and Windows SDK10.0.26100. A separate owned VS PID22968 (process start 2026-11-14T10:45:18.1077739Z) bound only the generated native fixture solution. Verified: connect/design, breakpoint creation (pending bound:false), launch, status/break with debuggee23584, metadata snapshot (3 threads, 8 frames, top Add/main, variablesEvaluated:false, position:null), step-over command return followed by break and another bounded snapshot, and owned breakpoint removal. This is direct bridge/executable verification, not yet parent Node-service integration. A step command return plus break observation alone does not prove exact source-line advancement because source position remained null.

Extended continue returned but remained in break until the bounded wait expired, potentially due to other persisted fixture breakpoints; root cause is unverified. Pause/detach/terminate/evaluate/attach were not established by that run. The script’s default verifies the core sequence only; -ExtendedCommands additionally attempts continue/pause/terminate and must not be represented as passing without its own evidence. All test-owned VS processes and the native debuggee were confirmed absent after finally cleanup, including PID22968 and bridge25520. No pre-existing VS instance received a command.

Reproduce after native CMake generation/build with bridge/IntegrationSmoke.ps1 -AllowNewVisualStudioFixture -NativeFixture [-Bridge absolute-path-to-candidate.exe]. It never auto-selects another PID. Repeated VS fixture sessions may persist user breakpoints under the generated fixture build directory; use a fresh generated build directory for clean extended acceptance.

Remaining full acceptance:  create/open a disposable solution in a dedicated VS, select the exact discovered instanceId and path, add breakpoint at marker, launch/wait break/snapshot/explicit evaluate/step/remove/continue/pause/detach; repeat attach and terminate against disposable fixture processes. Check solution switch and PID reuse rejection, user breakpoint preservation, busy handling and EOF leaving VS alive. Do not use an existing work VS session. COM behavior and per-engine members require this Windows/VS integration acceptance; static build or protocol tests do not prove them.
