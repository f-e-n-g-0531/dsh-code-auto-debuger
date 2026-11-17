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

## Real-host acceptance

Use the manually gated workflow described in [CI](ci.md), never a production solution. Explicitly select the VS instance and a fixture solution under test/fixtures. The test entrypoint is npm run test:integration; it requires DSH_AUTO_DEBUG_INTEGRATION=1 plus DSH_AUTO_DEBUG_VS_INSTANCE, DSH_AUTO_DEBUG_SOLUTION, DSH_AUTO_DEBUG_SOURCE (absolute fixture source path) and DSH_AUTO_DEBUG_LINE (positive executable breakpoint line). The strict smoke test verifies the expected function and exact marker source line, requires actual source/instruction advancement after step, queries owned breakpoints after deletion, and verifies cleanup of captured test-owned descendants. Missing source location or unproven advancement is not_verified failure, not PASS. Existing VS roots are retained; only newly observed owned descendants are eligible for cleanup. Do not convert missing prerequisites into skip/success.

Before approving 0.1.1 for actual use, retain evidence for discovery and exact target connection; breakpoint placement/removal; launch or explicit attach; pause/continue/step; bounded wait-for-break; snapshot shape and source/frame bounds; disconnection; and cancellation with external state independently checked. Evaluate and terminate only with separate explicit risk acknowledgment on disposable debuggees. Distinguish actions exercised by the automated integration runner from this broader manual acceptance checklist: a passing limited smoke test does not prove all debugger engines or all actions.

Exercise negative paths: ambiguous/missing instance; target process restart; solution change; foreign-session job access; expired preview; path escape/junction; oversized or malformed JSONL; bridge crash/hang; task timeout; cancellation in a mutating call. Unknown mutation outcome must stay unknown and must not be automatically retried. Do not treat truncated snapshots or missing evidence as full acceptance.

## New native fixture service smoke

After building the native CMake fixture, scripts/service-smoke.mjs can start its own dedicated VS instance only with DSH_AUTO_DEBUG_NEW_FIXTURE=1 and DSH_AUTO_DEBUG_VS_EXE pointing to devenv.exe. DSH_AUTO_DEBUG_FIXTURE_SOLUTION may select a freshly generated native solution below test/fixtures. It validates the complete Node-service preview/execute/wait/snapshot path and cleans only its owned fixture processes. It is not a production target automation script. Prefer a fresh generated solution to avoid persisted VS breakpoints. See [local acceptance](ACCEPTANCE-0.1.1.md).

## Reporting

Report exact commit, OS/VS/.NET/Node versions, selected fixture and tested actions, command exit codes, limitations and whether any real Visual Studio test ran. Remove sensitive locals, expressions, source paths and environment secrets before sharing logs. Candidate build success is not independent acceptance, release publication or production approval.
