import fs from "node:fs";
import assert from "node:assert/strict";
const files = ["ci.yml", "release-candidate.yml", "vs-integration.yml"];
for (const file of files) {
  const text = fs.readFileSync(
    new URL("../../.github/workflows/" + file, import.meta.url),
    "utf8",
  );
  assert(!text.includes("\0"), file + ": binary content");
  const trigger = text.split("\non:\n")[1]?.split("\npermissions:")[0];
  assert(trigger, file + ": explicit trigger block required");
  assert(
    !/^  (?:pull_request|pull_request_target|schedule|workflow_run|branches):/m.test(
      trigger,
    ),
    file + ": forbidden trigger",
  );
  const candidateText = text.split("\n  publish:")[0];
  assert(
    !/npm publish|gh release|contents: write|packages: write/.test(
      candidateText,
    ),
    file + ": validation job must remain read-only",
  );
  if (file === "release-candidate.yml") {
    assert(
      text.includes("needs: candidate") &&
        text.includes(
          "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
        ),
      "Publishing must be gated on validated tag artifacts",
    );
    assert(
      text.includes("secrets.NPM_AUTOMATION_TOKEN") &&
        text.includes("node scripts/ci/publish.mjs"),
      "npm automation credential flow missing",
    );
  } else
    assert(
      !/npm publish|gh release|contents: write|packages: write/.test(text),
      file + ": publishing forbidden",
    );
  assert(
    text.includes("node-version: '22'") &&
      text.includes("dotnet-version: '8.0.x'"),
    file + ": runtime versions",
  );
  for (const command of [
    "npm ci",
    "npm run check",
    "npm run build:bridge",
    "npm run test:bridge",
    "npm run verify:package",
  ])
    assert(text.includes("run: " + command), file + ": missing " + command);
  for (const command of [
    "npm run test:host",
    "npm run test:com",
    "./bridge/ProtocolSmoke.ps1 -BridgePath ./dist/bridge/win-x64/dsh-vs-bridge.exe",
  ])
    assert(text.includes("run: " + command), file + ": missing " + command);
  assert(
    text.includes("Required Windows bridge artifact is missing"),
    file + ": bridge preflight missing",
  );
  if (file === "vs-integration.yml") {
    assert(!/^  push:/m.test(trigger), "Real VS must be dispatch-only");
    assert(
      text.includes("I_ACKNOWLEDGE_ISOLATED_VS_EXECUTION") &&
        text.includes("merge-base --is-ancestor") &&
        text.includes("dsh-vs-interactive") &&
        text.includes("-RequireInteractive") &&
        text.includes("npm run test:integration"),
      "Integration gating missing",
    );
    assert(
      !text.includes("continue-on-error"),
      "Unavailable integration cannot pass",
    );
  } else {
    assert(
      /^  push:\n    tags: \['v\*'\]\n  workflow_dispatch:\s*$/m.test(trigger),
      file + ": Plan A exact trigger mismatch",
    );
  }
}
console.log(
  "PASS: three workflows preserve Plan A triggers, runtime/build contracts and candidate-only delivery",
);
