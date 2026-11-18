# Architecture

This is an **independent DSH plugin plus external Windows bridge**, not a Visual Studio extension. No VSIX is built or installed, and there is no execution-bus dependency. The AI is the current DSH conversation Agent: it reads relevant source through DSH tools, reasons about evidence and chooses each next action. The plugin has no separate model service, background reasoning loop or automatic source reader.

## Components and trust flow

1. The DSH conversation is the main entry point. Users describe the debugging goal and permitted scope; the panel observes evidence and offers takeover/cancel rather than requiring a handwritten plan. Model-facing tools and client RPC enter the same server-side debug service.
2. The server derives ownership from the DSH session and canonical workspace, not from model-supplied owner fields. It enforces target identity, risk permissions and finite budgets, and stores task evidence outside the target repository.
3. A child Windows x64/.NET 8 bridge exchanges bounded protocol-1 JSONL over standard input/output. It automates an explicitly selected running Visual Studio instance via COM/ROT. It is not an HTTP debug service.
4. Visual Studio owns the actual debugger and debuggee. Build, launching a target, evaluating expressions and debugger control can have external effects.

Discovery is not permission to connect, launch or attach. `connect` selects an explicit instance and an existing solution inside the session workspace. `begin` establishes one owner-bound authorization for a bounded debugging session (default: 64 operations and 10 minutes). Within that scope, the Agent sends one atomic operation with `perform`, inspects returned evidence and then decides what to do next; no complete action sequence is required in advance. Target identity and permissions are checked at the control boundary, not trusted from the prompt. Attach requires authorization for a fixed PID; evaluation may execute target code; termination needs separate explicit permission. A confirmation field asserts authorization; it is not independent evidence of human approval.

Legacy `preview` / `execute` remain compatible fixed-plan APIs, not the primary workflow; their plan limits are not the dynamic-session defaults. See the [user workflow](AI-DEBUGGING.md).

## Task lifecycle

Tasks record queued/running/succeeded/failed/cancelled/unknown outcomes. The server serializes ownership of a selected instance. Results are bounded and truncation must not be treated as complete evidence. Persistence allows observation after a process interruption; it does not justify replaying a mutation whose outcome is unknown.

Cancel stops further automation; takeover returns control to the user. Neither is a debugger pause or process kill, and neither proves that an in-flight operation stopped, the debuggee detached, or effects rolled back. Disconnect closes the bridge association without claiming to stop the debuggee. Inspect actual Visual Studio/debuggee state before further control.

## Baseline and non-goals

The plugin targets Windows x64, Node.js 22, .NET 8 and Visual Studio 2022. COM availability, elevation boundaries, debugger engines and UI readiness vary. The plugin does not install VSIX or modify an installed DSH profile. Publication is separate from runtime behavior. Hosted tests are not real-VS acceptance. See [testing](testing.md), [security](security.md), [CI](ci.md) and [releasing](releasing.md).

## Task recovery

Session-bound request IDs recover accepted tasks without repeating mutations. Metadata lists are paginated; complete evidence is fetched by job ID. Changing the current workspace revokes subsequent control but does not revoke the same session’s read/cancel capability for old tasks. Persistence status is independent of execution outcome; persistence failures keep bounded in-memory evidence, lock control, and never become replay permission.
