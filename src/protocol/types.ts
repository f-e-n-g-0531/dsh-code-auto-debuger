export type Owner = { sessionId: string; cwd: string };
export type Target = {
  instanceId: string;
  pid: number;
  startTime: string;
  solutionPath: string;
};
export type Step = { action: string; params: Record<string, unknown> };
export interface Bridge {
  request(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any>;
  close(): Promise<void>;
}
export class DebugError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(code: string, message: string): never {
  throw new DebugError(code, message);
}
export function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID_INPUT", "Expected object");
  const o = value as Record<string, any>;
  if (Object.keys(o).some((k) => !keys.includes(k)))
    fail("INVALID_INPUT", "Unknown field");
  return o;
}
export const PROTOCOL = 1;
