# Architecture

This is an **independent DSH plugin plus external Windows bridge**, not a Visual Studio extension. No VSIX is built or installed. There is no execution-bus dependency: bounded automation, ownership, preview and result persistence live inside this plugin.

## Components and trust flow

1. The DSH client contributes a debugging interface; model-facing tools and client RPC enter the same server-side debug service.
2. The server derives ownership from the DSH session and canonical workspace, not from model-supplied owner fields. It validates plans and stores task state outside the target repository.
3. A child Windows x64/.NET 8 bridge exchanges bounded protocol-1 JSONL over standard input/output. It automates an explicitly selected running Visual Studio instance via COM/ROT. It is not an HTTP debug service.
4. Visual Studio owns the actual debugger and debuggee. Build, launching a target, evaluating expressions and debugger control can have external effects.

Discovery is not permission to connect, launch or attach. Connect requires an explicit instance and an existing solution inside the session workspace. Target identity is checked before actions. A finite plan is previewed first; execution consumes a matching, owner-bound, expiring preview. Evaluation and termination require explicit plan risk switches. The confirmed flag is an authorization assertion, not independent evidence of human approval.

## Task lifecycle

Tasks record queued/running/succeeded/failed/cancelled/unknown outcomes. The server serializes ownership of a selected instance. Results are bounded and truncation must not be treated as complete evidence. Persistence allows observation after a process interruption; it does not justify replaying a mutation whose outcome is unknown.

Cancel stops the automation request. It does **not** prove that the debuggee paused, detached, terminated, or rolled back. Disconnect closes the bridge association without claiming to stop the debuggee. Inspect actual Visual Studio/debuggee state before further control.

## Baseline and non-goals

The candidate targets Windows x64, Node.js 22, .NET 8 and Visual Studio 2022. COM availability, elevation boundaries, debugger engines and UI readiness vary. The plugin does not install VSIX or modify an installed DSH profile. Publication is separate from runtime behavior. Hosted tests are not real-VS acceptance. See [testing](testing.md), [security](security.md), [CI](ci.md) and [releasing](releasing.md).

## Recovery in 0.1.2

Session-bound request IDs recover accepted tasks without repeating mutations. Metadata lists are paginated; complete evidence is fetched by job ID. Changing the current workspace revokes subsequent control but does not revoke the same session’s read/cancel capability for old tasks. Persistence status is independent of execution outcome; persistence failures keep bounded in-memory evidence, lock control, and never become replay permission.
