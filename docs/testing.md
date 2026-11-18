# Testing and acceptance

## Isolated build checks

Use Windows x64, Node.js 22 and .NET SDK 8 in a disposable checkout:

```powershell
npm ci
npm run build:bridge
npm run check
npm run test:host
npm run test:bridge
./bridge/ProtocolSmoke.ps1 -BridgePath ./dist/bridge/win-x64/dsh-vs-bridge.exe
npm run verify:package
npm run pack:candidate
npm run test:install
```

npm ci installs development dependencies in the checkout; it is not production plugin installation. test:install is an isolated package smoke test, not authorization to install into the current DSH profile. check covers the repository's type/build and unit-test contract. Unit tests with a fake bridge can prove policy and state handling but cannot prove VS COM behavior. verify:package checks distributable structure; inspect its failures rather than bypassing it.

## Dynamic AI workflow acceptance (not yet proven)

Version 0.1.5 contains the dynamic workflow. Existing C++ fixture results and legacy preview/execute smoke tests do not prove the new conversation-driven workflow or GUI. Record the following separately before claiming acceptance:

- Start from a user-described goal and scope in a real DSH conversation. Verify that the current DSH Agent reads relevant code, selects/connects the exact VS target, obtains one bounded `begin` authorization, and adapts each atomic `perform` only after inspecting its evidence. No handwritten plan or plugin-owned model backend should be needed.
- Verify the dynamic default budget (64 operations / 10 minutes), exhaustion/expiry, owner isolation, workspace changes, exact target checks and concurrent control rejection. Do not confuse these limits with the legacy fixed-plan budget.
- Reject evaluation without risk permission, attach without permission for the fixed PID, and terminate without separate permission. A changed PID or restarted target must not inherit authorization by process name.
- Verify that the panel observes evidence and offers takeover/cancel but does not originate `begin` / `perform`. Check independently that takeover/cancel prevents further automation without claiming to pause, kill or roll back the debuggee or stop an in-flight operation.
- Exercise lost responses, backend interruption, evidence pagination/truncation, persistence failure and unknown mutations. Query the original request and inspect actual VS state; never replay an unknown action or fall back to legacy execution to bypass it. Preserve compatibility tests for owner-bound, matching, expiring legacy previews.

These are acceptance requirements, not a report that they passed.

### Candidate first-install checklist (real DSH + VS)

Run `node scripts/prepare-host-acceptance.mjs <candidate-manifest.json>` to check the candidate archive's bytes and SHA-256 and create a fresh checklist under `.artifacts/dsh-host-runs/<run-id>/`. This does not install anything or report a pass.

1. In a disposable Windows account or VM, verify that the DSH profile and dependency directory are separate from daily use, with no prior copy or source link. Install the exact verified archive in that host, configure the plugin as shown in the [README](../README.md), restart, and record the resolved package version and loaded origin. Do not substitute a package with the same version.
2. Open the panel on a new fixture session. Verify it is idle without issuing a message or debugger command, and verify a real `auto_debug_capabilities` tool call. In the real conversation, explicitly authorize the dedicated VS fixture, observe `begin` and evidence-driven `perform`, and corroborate the breakpoint and stack in VS. Use panel takeover and confirm there are no new debugger commands; do not interpret it as pausing, terminating or rolling back the target.
3. Record DSH, VS and OS versions, per-check outcomes and redacted evidence in a result beside the checklist. A blocked or unobserved step stays blocked or not tested. Mark a full pass only after all checks and cleanup of test-owned resources pass.

## Real-host acceptance

Use the manually gated workflow described in [CI](ci.md), never a production solution. Explicitly select the VS instance and a fixture solution under test/fixtures. The test entrypoint is npm run test:integration; it requires DSH_AUTO_DEBUG_INTEGRATION=1 plus DSH_AUTO_DEBUG_VS_INSTANCE, DSH_AUTO_DEBUG_SOLUTION, DSH_AUTO_DEBUG_SOURCE (absolute fixture source path) and DSH_AUTO_DEBUG_LINE (positive executable breakpoint line). The strict smoke test verifies the expected function and exact marker source line, requires actual source/instruction advancement after step, queries owned breakpoints after deletion, and verifies cleanup of captured test-owned descendants. Missing source location or unproven advancement is not_verified failure, not PASS. Existing VS roots are retained; only newly observed owned descendants are eligible for cleanup. Do not convert missing prerequisites into skip/success. Each invocation writes its own `.artifacts/vs-runs/<run-id>/result.json`; a pass belongs only to that run and includes its cleanup scope.

For the underlying debugger actions, retain evidence for discovery and exact target connection; breakpoint placement/removal; launch or explicit attach; pause/continue/step; bounded wait-for-break; snapshot shape and source/frame bounds; disconnection; and cancellation with external state independently checked. Evaluate and terminate only with separate explicit risk acknowledgment on disposable debuggees. Distinguish actions exercised by the automated integration runner from this broader manual acceptance checklist: a passing limited smoke test does not prove all debugger engines or all actions.

Exercise negative paths: ambiguous/missing instance; target process restart; solution change; foreign-session job access; expired preview; path escape/junction; oversized or malformed JSONL; bridge crash/hang; task timeout; cancellation in a mutating call. Unknown mutation outcome must stay unknown and must not be automatically retried. Do not treat truncated snapshots or missing evidence as full acceptance.

## New native fixture service smoke

After building the native CMake fixture, scripts/service-smoke.mjs can start its own dedicated VS instance only with DSH_AUTO_DEBUG_NEW_FIXTURE=1 and DSH_AUTO_DEBUG_VS_EXE pointing to devenv.exe. DSH_AUTO_DEBUG_FIXTURE_SOLUTION may select a freshly generated native solution below test/fixtures. It validates the legacy Node-service preview/execute/wait/snapshot path and cleans only its owned fixture processes; it does not validate the dynamic `begin` / `perform` Agent loop. It is not a production target automation script. Prefer a fresh generated solution to avoid persisted VS breakpoints. See [local acceptance](ACCEPTANCE-0.1.1.md).

## Reporting

Report exact commit, OS/VS/.NET/Node versions, selected fixture and tested actions, command exit codes, limitations and whether any real Visual Studio test ran. Remove sensitive locals, expressions, source paths and environment secrets before sharing logs. Candidate build success is not independent acceptance, release publication or production approval.
