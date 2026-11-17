import path from "node:path";
import os from "node:os";
import { realpath } from "node:fs/promises";
import { DebugService } from "./core/debug-service.js";
import { JobStore, projectedPath } from "./jobs/store.js";
import { object, fail, type Owner } from "./protocol/types.js";
export { DebugService, JobStore };
export const name = "dsh-code-auto-debuger";
export const inject = ["tools", "connection", "webServer", "sessions", "sessionPersistence"];
const actions = [
  "capabilities",
  "discover",
  "connect",
  "status",
  "snapshot",
  "preview",
  "execute",
  "jobStatus",
  "cancel",
  "disconnect",
  "listJobs",
  "breakpoints",
] as const;
export function apply(ctx: any, config: Record<string, unknown> = {}) {
  // Host-owned state outside repositories; configuration is administrator-owned, never model input.
  const directory =
    typeof config.storageDirectory === "string"
      ? config.storageDirectory
      : path.join(os.homedir(), ".dsh", "auto-debug", "jobs");
  const service = new DebugService(
    new JobStore(directory),
    undefined,
    async (expected) => {
      const current = await owner(expected.sessionId);
      if (current.cwd !== expected.cwd)
        fail(
          "OWNER_CHANGED",
          "Session workspace changed; further debug controls are revoked",
        );
    },
  );
  async function owner(sessionId: string, recovery = false): Promise<Owner> {
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId.length > 256 ||
      /[\\/\0]/.test(sessionId)
    )
      fail("INVALID_OWNER", "Valid session required");
    const live = ctx.sessions.get(sessionId);
    const header =
      live?.header ?? (await ctx.sessionPersistence.stat(sessionId))?.header;
    if (!header?.cwd) fail("INVALID_OWNER", "Session unavailable");
    const cwd = recovery
      ? path.resolve(header.cwd)
      : await realpath(header.cwd);
    if (recovery) return { sessionId, cwd };
    const store = await projectedPath(directory);
    const rel = path.relative(cwd, store);
    if (
      !rel ||
      (!rel.startsWith(".." + path.sep) &&
        rel !== ".." &&
        !path.isAbsolute(rel))
    )
      fail("UNSAFE_STORE", "State directory cannot be in target workspace");
    return { sessionId, cwd };
  }
  async function dispatch(
    action: string,
    args: unknown,
    who: Owner,
    signal?: AbortSignal,
    wait = true,
  ) {
    signal?.throwIfAborted();
    switch (action) {
      case "capabilities":
        object(args, []);
        return service.capabilities();
      case "discover":
        object(args, []);
        return service.discover(signal);
      case "connect":
        return service.connect(who, args, signal);
      case "status":
        object(args, []);
        return service.status(who, signal);
      case "snapshot":
        object(args, []);
        return service.snapshot(who, signal);
      case "preview":
        return service.preview(who, args, signal);
      case "execute":
        return service.execute(who, args, signal, wait);
      case "listJobs":
        return service.listJobs(who, args);
      case "breakpoints":
        object(args, []);
        return service.ownedBreakpoints(who, signal);
      case "jobStatus":
        return service.jobStatus(who, args);
      case "cancel":
        return service.cancel(who, args);
      case "disconnect":
        object(args, []);
        return service.disconnect(who);
      default:
        return fail("UNKNOWN_ACTION", "Unknown action");
    }
  }
  const schemas: Record<string, any> = {
    capabilities: {},
    discover: {},
    connect: {
      instanceId: { type: "string" },
      solutionPath: { type: "string" },
    },
    status: {},
    snapshot: {},
    preview: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: [
                "breakpointAdd",
                "breakpointRemove",
                "launch",
                "attach",
                "continue",
                "pause",
                "step",
                "waitForBreak",
                "snapshot",
                "evaluate",
                "detach",
                "terminate",
              ],
            },
            params: { type: "object" },
          },
          required: ["action"],
        },
      },
      maxSteps: { type: "integer", minimum: 1, maximum: 64 },
      timeoutMs: { type: "integer", minimum: 100, maximum: 300000 },
      allowEvaluation: { type: "boolean" },
      allowTerminate: { type: "boolean" },
    },
    execute: {
      previewId: { type: "string" },
      confirmed: { type: "boolean" },
      requestId: { type: "string", maxLength: 128 },
    },
    listJobs: {
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      requestId: { type: "string", maxLength: 128 },
    },
    breakpoints: {},
    jobStatus: { jobId: { type: "string" } },
    cancel: { jobId: { type: "string" } },
    disconnect: {},
  };
  for (const action of actions)
    ctx.tools.register({
      name:
        "auto_debug_" +
        action.replace(/[A-Z]/g, (s: string) => "_" + s.toLowerCase()),
      description:
        action === "execute"
          ? "Execute a matching explicitly authorized finite Visual Studio debug preview. confirmed is an assertion, not independent human approval. Waits for task settlement; never replay unknown mutations. Does not edit source."
          : action === "preview"
            ? "Preview bounded external Visual Studio actions without running them. Requires selected instance. Evaluation and termination need explicit risk opt-ins."
            : action === "cancel"
              ? "Cancel owned automation; does NOT guarantee pausing, detaching or terminating the debuggee."
              : "External Visual Studio debugging: " +
                action +
                ". Operates only on current DSH session target; no VSIX.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: schemas[action],
        ...(action === "execute"
          ? { required: ["previewId", "confirmed"] }
          : action === "listJobs"
            ? {}
            : Object.keys(schemas[action]).length && action !== "preview"
              ? { required: Object.keys(schemas[action]) }
              : action === "preview"
                ? { required: ["steps"] }
                : {}),
      },
      output: {
        schema: { type: "object" },
        render: (_args: unknown, value: any) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args: unknown, exec: any) {
        const session = exec?.agent?.session;
        const who = await owner(
          session?.header?.id ?? session?.id,
          ["jobStatus", "cancel", "listJobs", "disconnect"].includes(action),
        );
        return dispatch(action, args, who, exec.signal, true);
      },
    });
  ctx.connection.register(
    ctx,
    "/auto-debug-rpc",
    async (endpoint: string, payload: any, signal?: AbortSignal) => {
      try {
        const o = object(payload, [
          "sessionId",
          "instanceId",
          "solutionPath",
          "steps",
          "maxSteps",
          "timeoutMs",
          "allowEvaluation",
          "allowTerminate",
          "previewId",
          "confirmed",
          "jobId",
          "requestId",
          "offset",
          "limit",
        ]);
        const { sessionId, ...args } = o;
        const who = await owner(
          sessionId,
          ["jobStatus", "cancel", "listJobs", "disconnect"].includes(endpoint),
        );
        return {
          ok: true,
          value: await dispatch(endpoint, args, who, signal, false),
        };
      } catch (e) {
        const error = e as Error & { code?: string };
        return {
          ok: false,
          error: {
            code: error.code ?? "DEBUG_ERROR",
            message: error.message.slice(0, 2048),
          },
        };
      }
    },
  );
  ctx.on("dispose", () => service.dispose());
  return service;
}
