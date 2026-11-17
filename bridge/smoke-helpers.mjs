import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function markerLine(source, marker = "BREAKPOINT:") {
  const lines = (await readFile(source, "utf8")).split(/\r?\n/);
  const hits = lines.flatMap((text, index) => text.includes(marker) ? [index + 1] : []);
  if (hits.length !== 1) throw Error("Marker must identify exactly one source line");
  return hits[0];
}
export async function fixturePath(file) {
  const root = await realpath("test/fixtures"), resolved = await realpath(file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw Error("Only repository fixtures may be used");
  return resolved;
}
const sameFile = (a, b) => typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export function assertBreakpointHit(snapshot, source, line, expectedFunction = "Add") {
  if (snapshot?.state !== "break" || snapshot.variablesEvaluated !== false || !snapshot.stack?.[0]?.function?.includes(expectedFunction))
    throw Error("Expected paused function not observed");
  if (!sameFile(snapshot.position?.file, source) || snapshot.position?.line !== line)
    throw Error("not_verified: newly-created breakpoint source/line hit not proven");
}
export function assertAdvancement(before, after) {
  const a = before?.position, b = after?.position;
  const sourceAdvanced = a?.file && a.line > 0 && b?.file && b.line > 0 && (!sameFile(a.file, b.file) || a.line !== b.line);
  const instructionAdvanced = a?.instruction && b?.instruction && a.instruction !== b.instruction;
  if (after?.state !== "break" || !(sourceAdvanced || instructionAdvanced))
    throw Error("not_verified: step returned but source/instruction advancement not proven");
}
async function powershell(command) {
  const { stdout } = await run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; " + command], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error("Invalid PID");
  return JSON.parse(await powershell(
    "$p=Get-Process -Id " + pid + "; try { @{pid=$p.Id;startTime=$p.StartTime.ToUniversalTime().ToString('O')}|ConvertTo-Json -Compress } finally {$p.Dispose()}"));
}
export function ownedDescendants(rows, parents, baseline = new Set()) {
  const result = new Map();
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      const key = row.pid + "@" + row.startTime;
      if (parents.has(row.parentPid) && !parents.has(row.pid) && !baseline.has(key) && Date.parse(row.startTime) >= Date.parse(parents.get(row.parentPid))) {
        parents.set(row.pid, row.startTime); result.set(row.pid, row.startTime); changed = true;
      }
    }
  } while (changed);
  return result;
}
async function processes() {
  return JSON.parse(await powershell("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startTime=$_.CreationDate.ToUniversalTime().ToString('O')} })"));
}
export function microIdentity(value) {
  // CIM carries six fractional digits; Get-Process carries seven. Never reduce
  // lineage to Date.parse milliseconds, and retain the full identity for kills.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|\+00:00)$/.exec(value);
  if (!match) throw Error("Invalid UTC creation identity");
  return match[1] + "." + (match[2] ?? "").padEnd(7,"0").slice(0,6) + "Z";
}
export function lineageRoots(rows, identities) {
  const roots = new Map();
  for (const row of rows) {
    const expected = identities.get(row.pid);
    if (expected && microIdentity(expected) === microIdentity(row.startTime)) roots.set(row.pid, microIdentity(expected));
  }
  return roots;
}
async function stopExact(pid, startTime) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !/^\d{4}-[0-9T:.Z+-]+$/.test(startTime)) throw Error("Invalid process identity");
  await powershell("$p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; if($p){try {if($p.StartTime.ToUniversalTime().ToString('O') -ne '" + startTime + "'){throw 'Cleanup refused changed identity'}; $p.Kill(); if(-not $p.WaitForExit(10000)){throw 'Cleanup timeout'}} finally{$p.Dispose()}}");
}
export class OwnedProcessLedger {
  constructor(root, includeRoot = false, io = {}) {
    this.root = root; this.includeRoot = includeRoot; this.owned = new Map(); this.baseline = new Set();
    this.io = { processes, processIdentity, stopExact, ...io };
  }
  async initialize() {
    this.baseline = this.includeRoot ? new Set() : new Set((await this.io.processes()).map(p => p.pid + "@" + microIdentity(p.startTime)));
  }
  async capture() {
    const rows = await this.io.processes();
    // A reparented owned child is an independent root even after VS exits.
    const identities = new Map(this.owned); identities.set(this.root.pid, this.root.startTime);
    const parents = lineageRoots(rows, identities);
    const normalized = rows.map(row => ({ ...row, startTime: microIdentity(row.startTime) }));
    const discovered = ownedDescendants(normalized, parents, this.baseline);
    for (const [pid, observed] of discovered) {
      const exact = await this.io.processIdentity(pid);
      if (microIdentity(exact.startTime) !== observed) throw Error("Child identity changed during capture");
      this.owned.set(pid, exact.startTime);
    }
    return rows;
  }
  async cleanup() {
    const errors = [];
    let clean = false;
    // Capture before each stop and after each round. Descendants that appear
    // during cleanup are added to the persistent ledger, not a one-shot list.
    for (let round = 0; round < 12; round++) {
      let rows;
      try { rows = await this.capture(); } catch (e) { errors.push(e); break; }
      const targets = new Map(this.owned);
      if (this.includeRoot) targets.set(this.root.pid, this.root.startTime);
      for (const row of rows) if (targets.has(row.pid) && microIdentity(targets.get(row.pid)) !== microIdentity(row.startTime)) errors.push(Error("Cleanup refused changed identity PID=" + row.pid));
      const live = rows.filter(row => targets.has(row.pid) && microIdentity(targets.get(row.pid)) === microIdentity(row.startTime));
      if (!live.length) { clean = true; break; }
      // Stop owned root first to prevent it from continuing to launch children.
      live.sort((a,b) => Number(b.pid === this.root.pid) - Number(a.pid === this.root.pid));
      for (const row of live) {
        try { await this.capture(); await this.io.stopExact(row.pid, targets.get(row.pid)); }
        catch (e) { errors.push(e); }
      }
    }
    if (!clean) errors.push(Error("Owned cleanup did not reach verified no-live-owned state"));
    if (errors.length) throw new AggregateError(errors, "Owned cleanup failed; NOT PASS");
  }
}
