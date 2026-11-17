# Security boundaries and limitations

## Authority

The plugin is a local debugging control surface, not a sandbox. It is independent of execution-bus and cannot inherit permissions or approval from another plugin. DSH session ownership, explicit target selection and matching previews constrain requests; they do not turn untrusted source/debugger output into instructions or prove that a human approved an action.

A Visual Studio solution can execute build tasks, startup programs, debuggee code and evaluator side effects. Never connect to a solution merely because a model requested it. Review its provenance, isolate the account and desktop, and use least privilege. Do not elevate the bridge to bypass VS access failures. Discovery is read-only selection evidence, not permission for attach or execution.

## Risk controls

- Canonical workspace checks bind existing solution/source paths to the session root. OS ACLs and trusted workspace contents remain necessary against races and tampering.
- Exact instance/target identity is revalidated. Multiple DSH sessions must not race one VS target.
- Plans have bounded step/time budgets and explicit preview/execute separation. Evaluation may run target code; termination can destroy unsaved target state. Both require explicit risk opt-in.
- Protocol size/depth checks reduce malformed-input exposure; the child bridge is still trusted code with the desktop user's authority. Do not expose its standard streams or RPC to unauthenticated networks.
- Cancellation or a killed bridge does not roll back external effects. Unknown outcomes require inspection, not mutation replay. Disconnect is not debuggee termination.

## Recovery and transport

A session workspace change revokes future controls but preserves same-session task observation, cancellation and connection release. Persistence failures retain bounded in-memory evidence and original outcome; storage failures are disclosed as incomplete lists, never empty-success evidence. Unknown actions are not retried. Task retention has limits; capacity exhaustion fails closed rather than dropping failed evidence. All child stdio error events are consumed; closing is idempotent and waits for close, with unconfirmed cleanup explicitly reported.

The bridge validates locality before mapping debuggee IDs onto local processes. Unverifiable or remote sessions are rejected, not treated as local PID matches. Add-return collections receive recovery IDs before Count/Item/Children/Type observations; partial observation must not trigger another Add.

## Data

Source snippets, locals, watches, expressions, process details and absolute paths can contain secrets. Task evidence is stored outside the repository in host-owned state; access follows the account's filesystem permissions. Configure appropriate ACLs and retention. Do not upload raw debugger snapshots automatically. Truncation is omission, not proof of a complete result. Clear sensitive evidence using a separately reviewed retention procedure; no automated destructive cleanup is implied here.

## CI and supply chain

The normal CI token is read-only; candidate artifacts are not signed, independently attested or published. v* triggers run source at the tag, so protect tags and review dependencies before allowing CI. Real-VS integration runs only via explicit acknowledgment on a reviewed tag on default-branch history and a dedicated self-hosted desktop runner. Configure branch/tag protections, environment reviewers and restricted runner groups outside the repository. Do not attach a privileged runner to untrusted forks or arbitrary branch workflows.

There is no promise of support for all VS editions/debugger engines, elevated targets, remote debugging, multiple concurrent control clients or unattended service sessions. Runtime availability is not acceptance. See [testing](testing.md) for the evidence required to narrow these limitations.
