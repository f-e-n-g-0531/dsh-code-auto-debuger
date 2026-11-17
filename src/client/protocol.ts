export type Data = Record<string, any>;
export type Action =
  | "capabilities"
  | "discover"
  | "connect"
  | "status"
  | "snapshot"
  | "investigation"
  | "takeover"
  | "listJobs"
  | "jobStatus"
  | "cancel"
  | "disconnect";
export interface Connection {
  rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<unknown>;
  };
}
export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function createRpc(connection: Connection) {
  return async (
    action: Action,
    sessionId: string,
    args: Data = {},
    signal?: AbortSignal,
  ): Promise<any> => {
    const envelope = (await connection.rpc.call(
      "/auto-debug-rpc",
      action,
      { sessionId, ...args },
      signal,
    )) as Data;
    if (!envelope || typeof envelope.ok !== "boolean")
      throw new RpcError("INVALID_ENVELOPE", "后台响应不可识别，结果未知。");
    if (!envelope.ok)
      throw new RpcError(
        envelope.error?.code || "UNAVAILABLE",
        envelope.error?.message || "后台不可用",
      );
    return envelope.value;
  };
}
export interface Step {
  action: string;
  params: Data;
}
export function parsePlan(
  text: string,
  maxSteps: number,
  timeoutMs: number,
): { steps: Step[]; maxSteps: number; timeoutMs: number } {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32)
    throw new Error("最大步数须为 1–32 的整数。");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 300000
  )
    throw new Error("超时须为 1000–300000 毫秒的整数。");
  const steps = JSON.parse(text);
  if (!Array.isArray(steps) || !steps.length || steps.length > maxSteps)
    throw new Error("计划须为非空步骤数组，且不得超过最大步数。");
  for (const step of steps) {
    if (
      !step ||
      typeof step.action !== "string" ||
      !step.action.trim() ||
      !step.params ||
      typeof step.params !== "object" ||
      Array.isArray(step.params)
    )
      throw new Error("每步须包含 action 字符串与 params 对象。");
    if (Object.keys(step).some((key) => key !== "action" && key !== "params"))
      throw new Error("步骤仅接受 action、params 字段。");
  }
  return { steps, maxSteps, timeoutMs };
}
export const terminalJob = (value: Data | null) =>
  [
    "succeeded",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "unknown",
    "persistence_failed",
  ].includes(value?.state ?? value?.status);
export const pretty = (value: unknown) =>
  JSON.stringify(value, null, 2) ?? "未提供";
export const errorText = (error: unknown) =>
  error instanceof Error
    ? ((error as RpcError).code ? "[" + (error as RpcError).code + "] " : "") +
      error.message
    : String(error);
