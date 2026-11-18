# CI: Plan A

Only version-tag pushes matching v\* and workflow_dispatch are configured. **No branch push, pull-request or schedule trigger exists.** This intentionally trades automatic branch feedback for controlled candidate execution. Branch checks must be run locally or explicitly dispatched.

## Hosted Windows jobs

[Candidate CI](https://github.com/f-e-n-g-0531/dsh-code-auto-debuger/blob/v0.1.6/.github/workflows/ci.yml) and [candidate delivery](https://github.com/f-e-n-g-0531/dsh-code-auto-debuger/blob/v0.1.6/.github/workflows/release-candidate.yml) use windows-latest, Node.js 22 and .NET SDK 8. Both run, in order:

```powershell
./scripts/ci/check-environment.ps1
npm ci
npm run build:bridge
npm run check
npm run test:host
npm run test:com
npm run test:bridge
./bridge/ProtocolSmoke.ps1 -BridgePath ./dist/bridge/win-x64/dsh-vs-bridge.exe
npm run verify:package
```

The delivery workflow additionally runs npm run pack:candidate and the [release checker](https://github.com/f-e-n-g-0531/dsh-code-auto-debuger/blob/v0.1.6/scripts/ci/release-check.mjs), runs the isolated package-install smoke test, then uploads only candidate archives and their manifest. Validation token permissions are contents: read; checkout does not persist credentials. Validation jobs remain read-only. Only version-tag pushes enable a separate publish job, using NPM_AUTOMATION_TOKEN to publish the validated package to npm latest and create a GitHub Release; manual dispatch remains candidate-only. There is no production plugin install or VSIX action.

## Real Visual Studio integration

[Real VS integration](https://github.com/f-e-n-g-0531/dsh-code-auto-debuger/blob/v0.1.6/.github/workflows/vs-integration.yml) is workflow_dispatch **only**. It cannot be triggered by a tag push. Dispatch from the repository default branch, explicitly enter I_ACKNOWLEDGE_ISOLATED_VS_EXECUTION, choose reviewed v0.1.6, and provide an exact running VS instance identifier and dedicated repository-relative solution below test/fixtures/, its absolute fixture source path on the runner, and a positive executable breakpoint line.

A hosted authorization job validates that the selected version tag resolves to a commit on default-branch history. It passes the immutable commit SHA to checkout on the self-hosted runner. Inputs are passed through environment variables, never interpolated into shell source. This ref check is only meaningful with trusted maintainers and protected default branch/version tags; it is not code review or approval by itself.

Provision a **dedicated disposable** self-hosted Windows x64 runner labeled dsh-vs-interactive and a vs-integration GitHub environment. Configure environment required reviewers, restricted deployment branches and runner-group repository access administratively before enabling it. The repository cannot enforce those host settings. Run the runner under a logged-in desktop account, not a Windows service. Preinstall VS2022 and required workloads; open only the dedicated test solution. Do not expose credentials, production workspaces or other sessions.

Environment checks require an interactive non-session-0 desktop with Explorer in the same session. The test receives DSH_AUTO_DEBUG_INTEGRATION=1, DSH_AUTO_DEBUG_VS_INSTANCE, DSH_AUTO_DEBUG_SOLUTION, DSH_AUTO_DEBUG_SOURCE (absolute path inside test/fixtures) and DSH_AUTO_DEBUG_LINE. Missing VS/selection, wrong solution, unsupported environment or unavailable COM must exit nonzero: **unavailable is failure, never a passing skip**. An offline runner leaves the job queued; queued/cancelled/skipped is not acceptance. Operators must cancel stale jobs and record unavailable evidence rather than report success.

All jobs are time-bounded after starting; real integration is serialized. The [summary script](https://github.com/f-e-n-g-0531/dsh-code-auto-debuger/blob/v0.1.6/scripts/ci/summarize.ps1) records status and candidate hash without upgrading hosted checks into a real-VS claim. Workflow results must be checked separately from authoring or pushing their source.
