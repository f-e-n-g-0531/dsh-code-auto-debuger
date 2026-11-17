import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DebugError, type Bridge } from "../protocol/types.js";
export type BridgeTransportOptions = {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  closeTimeoutMs?: number;
};
export class BridgeClient implements Bridge {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  private buffer = "";
  private dead = false;
  private closePromise?: Promise<void>;
  private closed?: Promise<void>;
  private resolveClosed?: () => void;
  private diagnostics: string[] = [];
  constructor(
    private executable = fileURLToPath(
      new URL("./bridge/win-x64/dsh-vs-bridge.exe", import.meta.url),
    ),
    private options: BridgeTransportOptions = {},
  ) {}
  private start() {
    if (this.dead)
      throw new DebugError("BRIDGE_CLOSED", "Reconnect using a fresh bridge");
    if (this.child) return;
    if (process.platform !== "win32" && !this.options.spawnProcess)
      throw new DebugError("UNSUPPORTED_PLATFORM", "Windows is required");
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    const child = (this.child = (this.options.spawnProcess ?? spawn)(
      this.executable,
      [],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    ) as ChildProcessWithoutNullStreams);
    // Child process errors and each stdio error are independent EventEmitters.
    const streamError = () =>
      this.abort(
        "OUTCOME_UNKNOWN",
        "Bridge transport failed; inspect external state before any mutation",
      );
    child.stdin.on("error", streamError);
    child.stdout.on("error", streamError);
    child.stderr.on("error", streamError);
    child.stdin.on("close", () => {
      if (this.pending.size)
        this.abort("OUTCOME_UNKNOWN", "Bridge input closed during request");
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      // Codes only; never save arbitrary expressions or COM details.
      for (const code of data.match(
        /\b(?:BUSY|COM_ERROR|BRIDGE_ERROR|INVALID_REQUEST|TARGET_MISMATCH|OUTCOME_UNKNOWN)\b/g,
      ) ?? []) {
        this.diagnostics.push(code);
        if (this.diagnostics.length > 32) this.diagnostics.shift();
      }
    });
    child.stdout.on("data", (data: string) => {
      this.buffer += data;
      if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) {
        this.abort("BRIDGE_PROTOCOL", "Oversized bridge output");
        return;
      }
      let pos: number;
      while ((pos = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, pos);
        this.buffer = this.buffer.slice(pos + 1);
        try {
          const r = JSON.parse(line);
          if (
            r.protocol !== 1 ||
            typeof r.id !== "string" ||
            typeof r.ok !== "boolean"
          )
            throw Error();
          const p = this.pending.get(r.id);
          if (!p) throw Error();
          this.pending.delete(r.id);
          p.cleanup();
          if (r.ok) p.resolve(r.value);
          else
            p.reject(
              new DebugError(
                typeof r.error?.code === "string"
                  ? r.error.code
                  : "BRIDGE_ERROR",
                typeof r.error?.message === "string"
                  ? r.error.message
                  : "Bridge request failed",
              ),
            );
        } catch {
          this.abort("BRIDGE_PROTOCOL", "Invalid bridge response");
          return;
        }
      }
    });
    child.on("error", () =>
      this.abort("BRIDGE_UNAVAILABLE", "Bridge executable could not start"),
    );
    child.on("exit", () =>
      this.abort(
        "BRIDGE_EXITED",
        "Bridge exited; external VS state must be inspected",
        false,
      ),
    );
    child.on("close", () => {
      this.dead = true;
      this.resolveClosed?.();
    });
  }
  private abort(code: string, message: string, kill = true) {
    this.dead = true;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(new DebugError(code, message));
    }
    this.pending.clear();
    if (
      kill &&
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
      this.child.kill();
  }
  diagnosticsSnapshot() {
    return [...this.diagnostics];
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    signal?.throwIfAborted();
    const id = randomUUID(),
      line = JSON.stringify({ protocol: 1, id, method, params }) + "\n";
    if (Buffer.byteLength(line) > 65536)
      throw new DebugError("INVALID_INPUT", "Request exceeds 64KiB");
    this.start();
    if (this.pending.size)
      throw new DebugError(
        "BRIDGE_BUSY",
        "Only one bridge request may be in flight",
      );
    return new Promise((resolve, reject) => {
      const stop = () =>
        this.abort(
          "OUTCOME_UNKNOWN",
          "Bridge request cancelled or timed out; do not replay mutations",
        );
      const timer = setTimeout(stop, this.options.timeoutMs ?? 15000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) {
        stop();
        return;
      }
      try {
        this.child!.stdin.write(line, (error) => {
          if (error)
            this.abort(
              "OUTCOME_UNKNOWN",
              "Bridge write failed; inspect external state",
            );
        });
      } catch {
        this.abort(
          "OUTCOME_UNKNOWN",
          "Bridge write failed; inspect external state",
        );
      }
    });
  }
  close() {
    return (this.closePromise ??= this.closeInternal());
  }
  private async closeInternal() {
    const child = this.child;
    if (!child) {
      this.dead = true;
      return;
    }
    if (!this.dead && !this.pending.size) {
      try {
        await this.request("disconnect", {});
      } catch {
        /* never replay */
      }
    }
    this.abort("BRIDGE_CLOSED", "Bridge closed; VS was not terminated");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DebugError(
                  "BRIDGE_CLEANUP_UNCONFIRMED",
                  "Bridge stdio did not close; process cleanup unconfirmed",
                ),
              ),
            this.options.closeTimeoutMs ?? 5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
