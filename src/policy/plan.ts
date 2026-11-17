import path from "node:path";
import { realpath } from "node:fs/promises";
import { object, fail, type Step } from "../protocol/types.js";
const fields: Record<string, string[]> = {
  breakpointAdd: ["file", "line"],
  breakpointRemove: ["breakpointId"],
  launch: [],
  attach: ["processId"],
  continue: [],
  pause: [],
  step: ["kind"],
  waitForBreak: ["timeoutMs"],
  snapshot: [],
  evaluate: ["expression"],
  detach: [],
  terminate: [],
};
export const mutating = new Set([
  "breakpointAdd",
  "breakpointRemove",
  "launch",
  "attach",
  "continue",
  "pause",
  "step",
  "evaluate",
  "detach",
  "terminate",
]);
export async function canonicalInside(root: string, file: string) {
  const [base, target] = await Promise.all([realpath(root), realpath(file)]);
  const rel = path.relative(base, target);
  if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel))
    fail("OUTSIDE_WORKSPACE", "Target must be inside session workspace");
  return target;
}
export async function validatePlan(raw: unknown, cwd: string) {
  const o = object(raw, [
    "steps",
    "maxSteps",
    "timeoutMs",
    "allowEvaluation",
    "allowTerminate",
  ]);
  if (!Array.isArray(o.steps) || o.steps.length < 1 || o.steps.length > 64)
    fail("INVALID_PLAN", "Plan requires 1..64 steps");
  const maxSteps = o.maxSteps ?? 32,
    timeoutMs = o.timeoutMs ?? 60000;
  if (
    !Number.isSafeInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > 64 ||
    o.steps.length > maxSteps ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 300000
  )
    fail("INVALID_PLAN", "Invalid execution budget");
  if (
    (o.allowEvaluation !== undefined &&
      typeof o.allowEvaluation !== "boolean") ||
    (o.allowTerminate !== undefined && typeof o.allowTerminate !== "boolean")
  )
    fail("INVALID_PLAN", "Risk switches must be booleans");
  const steps: Step[] = [];
  for (const value of o.steps) {
    const s = object(value, ["action", "params"]);
    if (typeof s.action !== "string" || !Object.hasOwn(fields, s.action))
      fail("INVALID_PLAN", "Unknown action");
    const p = object(s.params ?? {}, fields[s.action]);
    if (s.action === "breakpointAdd") {
      if (
        typeof p.file !== "string" ||
        !Number.isSafeInteger(p.line) ||
        p.line < 1 ||
        p.line > 10000000
      )
        fail("INVALID_PLAN", "Invalid breakpoint");
      p.file = await canonicalInside(cwd, path.resolve(cwd, p.file));
    }
    if (
      s.action === "breakpointRemove" &&
      (typeof p.breakpointId !== "string" || p.breakpointId.length > 256)
    )
      fail("INVALID_PLAN", "Invalid breakpoint id");
    if (
      s.action === "attach" &&
      (!Number.isSafeInteger(p.processId) || p.processId <= 0)
    )
      fail("INVALID_PLAN", "Invalid process id");
    if (s.action === "step" && !["over", "into", "out"].includes(p.kind))
      fail("INVALID_PLAN", "Invalid step kind");
    if (
      s.action === "waitForBreak" &&
      (!Number.isSafeInteger(p.timeoutMs) ||
        p.timeoutMs < 100 ||
        p.timeoutMs > timeoutMs)
    )
      fail("INVALID_PLAN", "Invalid wait budget");
    if (s.action === "evaluate") {
      if (o.allowEvaluation !== true)
        fail(
          "RISK_NOT_AUTHORIZED",
          "Expression evaluation can run target code; explicitly opt in",
        );
      if (
        typeof p.expression !== "string" ||
        !p.expression.trim() ||
        p.expression.length > 2048
      )
        fail("INVALID_PLAN", "Invalid expression");
    }
    if (s.action === "terminate" && o.allowTerminate !== true)
      fail("RISK_NOT_AUTHORIZED", "Termination requires explicit opt in");
    steps.push({ action: s.action, params: structuredClone(p) });
  }
  return {
    steps,
    maxSteps,
    timeoutMs,
    allowEvaluation: o.allowEvaluation === true,
    allowTerminate: o.allowTerminate === true,
  };
}
