import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeClient } from "../bridge/client.js";
import { JobStore, type Job } from "../jobs/store.js";
import { canonicalInside, validatePlan, mutating } from "../policy/plan.js";
import {
  object,
  fail,
  type Owner,
  type Bridge,
  type Target,
} from "../protocol/types.js";
const targetLocks = new Map<string, string>();
const key = (o: Owner) => JSON.stringify(o);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Connection = {
  bridge: Bridge;
  target: Target;
  busy: boolean;
  uncertain?: boolean;
  owner: Owner;
};
type Preview = {
  owner: Owner;
  connection: Connection;
  target: Target;
  debugState: any;
  plan: Awaited<ReturnType<typeof validatePlan>>;
  expiresAt: number;
};
type Active = { record: Job; controller: AbortController; done: Promise<void> };
export class DebugService {
  private connections = new Map<string, Connection>();
  private previews = new Map<string, Preview>();
  private active = new Map<string, Active>();
  private closed = false;
  private backendId = randomUUID();
  private completed = new Map<string, Job>();
  private requests = new Map<
    string,
    { signature: string; result: Promise<string> }
  >();
  private pendingConnections = new Map<string, Promise<unknown>>();
  private transient = new Map<Bridge, Promise<void>>();
  constructor(
    private store: JobStore,
    private factory: () => Bridge = () => new BridgeClient(),
    private authorize: (owner: Owner) => Promise<void> = async () => {},
  ) {}
  capabilities() {
    return {
      version: "0.1.3",
      backendId: this.backendId,
      protocol: 1,
      available: process.platform === "win32",
      verified: false,
      limitations: [
        "External COM only; no VSIX",
        "Windows x64 / VS2022 baseline; real-host acceptance recorded separately",
        "No implicit evaluation, no source editing, no mutation replay",
        "Cancel stops automation, not debuggee",
      ],
    };
  }
  private connection(owner: Owner) {
    if (this.closed) fail("CLOSED", "Service disposed");
    return (
      this.connections.get(key(owner)) ??
      fail("NOT_CONNECTED", "Select and connect a Visual Studio instance")
    );
  }
  private idle(c: Connection) {
    if (c.busy) fail("BUSY", "A task or lifecycle operation owns this target");
  }
  private async exclusive<T>(c: Connection, work: () => Promise<T>) {
    this.idle(c);
    c.busy = true;
    try {
      return await work();
    } finally {
      c.busy = false;
    }
  }
  async discover(signal?: AbortSignal) {
    if (this.closed) fail("CLOSED", "Service disposed");
    const bridge = this.factory();
    let settled!: () => void;
    const lifetime = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.transient.set(bridge, lifetime);
    try {
      return await bridge.request("discover", {}, signal);
    } finally {
      try {
        await bridge.close();
      } finally {
        this.transient.delete(bridge);
        settled();
      }
    }
  }
  async connect(owner: Owner, raw: unknown, signal?: AbortSignal) {
    await this.authorize(owner);
    const k = key(owner);
    if (this.closed) fail("CLOSED", "Service disposed");
    if (this.pendingConnections.has(k))
      fail("ALREADY_CONNECTED", "Connection in progress");
    const work = this.connectInternal(owner, raw, signal);
    this.pendingConnections.set(k, work);
    try {
      return await work;
    } finally {
      this.pendingConnections.delete(k);
    }
  }
  private async connectInternal(
    owner: Owner,
    raw: unknown,
    signal?: AbortSignal,
  ) {
    const p = object(raw, ["instanceId", "solutionPath"]);
    if (
      typeof p.instanceId !== "string" ||
      p.instanceId.length > 1024 ||
      typeof p.solutionPath !== "string"
    )
      fail("INVALID_INPUT", "Explicit instance and solution required");
    const solutionPath = await canonicalInside(
      owner.cwd,
      path.resolve(owner.cwd, p.solutionPath),
    );
    if (this.closed) fail("CLOSED", "Service disposed");
    if (this.connections.has(key(owner)))
      fail("ALREADY_CONNECTED", "Disconnect previous instance first");
    if (targetLocks.has(p.instanceId))
      fail("TARGET_BUSY", "Instance controlled by another session");
    targetLocks.set(p.instanceId, key(owner));
    const bridge = this.factory();
    try {
      const value = await bridge.request(
        "connect",
        { instanceId: p.instanceId, solutionPath },
        signal,
      );
      const target = value.target as Target;
      if (
        !target ||
        target.instanceId !== p.instanceId ||
        !Number.isSafeInteger(target.pid) ||
        typeof target.startTime !== "string" ||
        typeof target.solutionPath !== "string" ||
        !same(
          (await canonicalInside(owner.cwd, target.solutionPath)).toLowerCase(),
          solutionPath.toLowerCase(),
        )
      )
        fail("TARGET_MISMATCH", "Bridge target identity mismatch");
      if (this.closed) fail("CLOSED", "Service disposed during connect");
      this.connections.set(key(owner), {
        bridge,
        target: structuredClone(target),
        busy: false,
        owner,
      });
      return value;
    } catch (e) {
      targetLocks.delete(p.instanceId);
      await bridge.close();
      throw e;
    }
  }
  private async verified(c: Connection, signal?: AbortSignal) {
    await this.authorize(c.owner);
    let v: any;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.authorize(c.owner);
        v = await c.bridge.request("status", {}, signal);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "BUSY" || attempt >= 20) throw e;
        await delay(150, undefined, { signal });
      }
    }
    if (!same(v.target, c.target))
      fail("TARGET_CHANGED", "Target changed; reconnect and preview again");
    return v;
  }
  async status(owner: Owner, signal?: AbortSignal) {
    const c = this.connection(owner);
    return this.exclusive(c, () => this.verified(c, signal));
  }
  async ownedBreakpoints(owner: Owner, signal?: AbortSignal) {
    const c = this.connection(owner);
    return this.exclusive(c, async () => {
      await this.verified(c, signal);
      await this.authorize(owner);
      return c.bridge.request("listOwnedBreakpoints", {}, signal);
    });
  }
  async snapshot(owner: Owner, signal?: AbortSignal) {
    const c = this.connection(owner);
    return this.exclusive(c, async () => {
      await this.verified(c, signal);
      return c.bridge.request("snapshot", {}, signal);
    });
  }
  async preview(owner: Owner, raw: unknown, signal?: AbortSignal) {
    const c = this.connection(owner);
    if (c.uncertain)
      fail(
        "RECONNECT_REQUIRED",
        "Previous outcome unknown; inspect VS and explicitly reconnect before new preview",
      );
    return this.exclusive(c, async () => {
      const plan = await validatePlan(structuredClone(raw), owner.cwd);
      const debugState = await this.verified(c, signal);
      for (const step of plan.steps) {
        if (step.action === "attach") {
          const process = await c.bridge.request(
            "processDescribe",
            { processId: step.params.processId },
            signal,
          );
          if (typeof process.startTime !== "string")
            fail("TARGET_CHANGED", "Process identity unavailable");
          step.params.expectedStartTime = process.startTime;
        }
      }
      for (const [id, p] of this.previews)
        if (p.expiresAt <= Date.now() || same(p.owner, owner))
          this.previews.delete(id);
      if (this.previews.size >= 128)
        fail("CAPACITY", "Preview capacity reached");
      const previewId = randomUUID(),
        expiresAt = Date.now() + 120000;
      this.previews.set(previewId, {
        owner: structuredClone(owner),
        connection: c,
        target: structuredClone(c.target),
        debugState: structuredClone(debugState),
        plan,
        expiresAt,
      });
      return {
        previewId,
        target: structuredClone(c.target),
        debugState: structuredClone(debugState),
        ...structuredClone(plan),
        expiresAt,
        warnings: [
          "Controls and launch may affect external systems",
          "Cancel does not pause or terminate the target",
          ...(plan.allowEvaluation
            ? ["Expression evaluation may execute target code"]
            : []),
          ...(plan.allowTerminate
            ? ["Plan explicitly permits terminating debuggee processes"]
            : []),
        ],
      };
    });
  }
  async execute(
    owner: Owner,
    raw: unknown,
    signal?: AbortSignal,
    wait = true,
  ): Promise<Job> {
    const p = object(raw, ["previewId", "confirmed", "requestId"]);
    if (p.requestId === undefined)
      return this.executeNew(owner, p, signal, wait);
    if (
      typeof p.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(p.requestId)
    )
      fail("INVALID_INPUT", "Invalid requestId");
    const requestKey = JSON.stringify([owner.sessionId, p.requestId]);
    const signature = JSON.stringify([owner.cwd, p.previewId, p.confirmed]);
    const previous = this.requests.get(requestKey);
    if (previous) {
      if (previous.signature !== signature)
        fail("REQUEST_CONFLICT", "requestId parameters changed");
      const jobId = await previous.result;
      if (!jobId)
        fail(
          "REQUEST_FAILED",
          "Original request failed; no automatic replay permitted",
        );
      return this.jobStatus(owner, { jobId });
    }
    if (this.requests.size >= 1024)
      fail(
        "CAPACITY",
        "Request retention capacity reached; no replay permitted",
      );
    const result = (async () => {
      const previous = (await this.store.list(owner)).find(
        (j) => j.requestId === p.requestId,
      );
      if (previous) {
        if (
          previous.owner.cwd !== owner.cwd ||
          previous.previewId !== p.previewId ||
          p.confirmed !== true
        )
          fail("REQUEST_CONFLICT", "requestId parameters changed");
        return this.store.read(previous.jobId, owner);
      }
      return this.executeNew(owner, p, signal, wait);
    })();
    this.requests.set(requestKey, {
      signature,
      result: result.then(
        (job) => job.jobId,
        () => "",
      ),
    });
    return result;
  }
  private async executeNew(
    owner: Owner,
    p: Record<string, any>,
    signal?: AbortSignal,
    wait = true,
  ): Promise<Job> {
    if (p.confirmed !== true)
      fail(
        "CONFIRMATION_REQUIRED",
        "Execute only explicitly authorized matching preview",
      );
    const preview = this.previews.get(p.previewId);
    if (
      !preview ||
      !same(preview.owner, owner) ||
      preview.expiresAt <= Date.now()
    )
      fail("PREVIEW_EXPIRED", "Preview expired or foreign");
    await this.authorize(owner);
    const c = this.connection(owner);
    this.idle(c);
    if (c.uncertain)
      fail(
        "RECONNECT_REQUIRED",
        "Previous outcome or persistence uncertain; reconnect explicitly",
      );
    while (this.active.size + this.completed.size >= 128) {
      const evict = [...this.completed].find(
        ([, j]) => j.persistence?.status !== "failed",
      );
      if (evict) this.completed.delete(evict[0]);
      else fail("CAPACITY", "Retained task capacity reached");
    }
    if (preview.connection !== c || !same(c.target, preview.target))
      fail("TARGET_CHANGED", "Reconnect requires fresh preview");
    this.previews.delete(p.previewId);
    c.busy = true;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (wait) {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }
    const record: Job = {
      jobId: randomUUID(),
      owner: structuredClone(owner),
      target: c.target,
      status: "queued",
      steps: preview.plan.steps,
      results: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      externalState: "unconfirmed",
      persistence: { status: "pending" },
      requestId: p.requestId,
      previewId: p.previewId,
    };
    const active: Active = { record, controller, done: Promise.resolve() };
    this.active.set(record.jobId, active);
    // The tool returns only after owned work settles; GUI can observe/cancel via separate RPC.
    active.done = this.run(c, preview, active)
      .catch((error) => {
        this.persistenceFailure(c, record, error);
      })
      .finally(() => {
        c.busy = false;
        signal?.removeEventListener("abort", abort);
        this.completed.set(record.jobId, record);
        this.active.delete(record.jobId);
      });
    if (wait) await active.done;

    return structuredClone(record);
  }
  private async run(c: Connection, p: Preview, a: Active) {
    let inFlightMutation = false;
    const r = a.record;
    const timer = setTimeout(
      () => a.controller.abort(new Error("Task budget exceeded")),
      p.plan.timeoutMs,
    );
    const signal = a.controller.signal;
    try {
      await this.persist(c, r);
      signal.throwIfAborted();
      const current = await this.verified(c, signal);
      if (
        current.state !== p.debugState.state ||
        !same(current.debuggees ?? [], p.debugState.debuggees ?? [])
      )
        fail(
          "TARGET_CHANGED",
          "Debugger state or debuggee identity changed after preview",
        );
      r.status = "running";
      await this.persist(c, r);
      let expectedDebuggees = current.debuggees ?? [];
      let awaitingLaunch = false;
      for (let i = 0; i < p.plan.steps.length; i++) {
        signal.throwIfAborted();
        const s = p.plan.steps[i];
        const observed = await this.verified(c, signal);
        if (awaitingLaunch && expectedDebuggees.length === 0)
          expectedDebuggees = observed.debuggees ?? [];
        if (!same(observed.debuggees ?? [], expectedDebuggees))
          fail(
            "TARGET_CHANGED",
            "Debuggee identity changed between plan steps",
          );
        if (s.action === "breakpointAdd")
          await canonicalInside(r.owner.cwd, s.params.file as string);
        await this.authorize(r.owner);
        signal.throwIfAborted();
        inFlightMutation = mutating.has(s.action);
        let value: any;
        if (s.action === "waitForBreak") {
          const until = Date.now() + (s.params.timeoutMs as number);
          do {
            signal.throwIfAborted();
            value = await this.verified(c, signal);
            if (awaitingLaunch && expectedDebuggees.length === 0)
              expectedDebuggees = value.debuggees ?? [];
            if (!same(value.debuggees ?? [], expectedDebuggees))
              fail("TARGET_CHANGED", "Debuggee changed during wait");
            if (value.state === "break") {
              awaitingLaunch = false;
              break;
            }
            if (value.state === "design" && !awaitingLaunch)
              fail("TARGET_EXITED", "Target is not running");
            await delay(100, undefined, { signal });
          } while (Date.now() < until);
          if (value.state !== "break")
            fail("WAIT_TIMEOUT", "Target did not pause within budget");
        } else value = await c.bridge.request(s.action, s.params, signal);
        if (["launch", "attach", "detach", "terminate"].includes(s.action)) {
          const after = await this.verified(c, signal);
          expectedDebuggees = after.debuggees ?? [];
          awaitingLaunch = s.action === "launch";
        }
        inFlightMutation = false;
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) > 256 * 1024)
          value = {
            truncated: true,
            bytes: Buffer.byteLength(encoded),
            notice: "Evidence omitted; not complete",
          };
        r.results.push({
          index: i,
          action: s.action,
          observedAt: new Date().toISOString(),
          value,
        });
        r.updatedAt = new Date().toISOString();
        await this.persist(c, r);
      }
      r.status = "succeeded";
      r.externalState = "last_observed_not_stopped";
    } catch (e) {
      const error = e as Error & { code?: string };
      if (r.persistence?.status === "failed") return;
      r.status = inFlightMutation
        ? "unknown"
        : signal.aborted
          ? "cancelled"
          : "failed";
      r.externalState = "unknown";
      if (inFlightMutation) c.uncertain = true;
      r.error = {
        code: inFlightMutation
          ? "OUTCOME_UNKNOWN"
          : (error.code ?? "DEBUG_FAILED"),
        message: error.message.slice(0, 2048),
      };
    } finally {
      clearTimeout(timer);
      r.updatedAt = new Date().toISOString();
      if (r.persistence?.status !== "failed") {
        try {
          await this.persist(c, r);
        } catch {
          /* Explicit failure retained in memory. */
        }
      }
    }
  }
  private persistenceFailure(c: Connection, r: Job, error: unknown) {
    const e = error as Error & { code?: string };
    if (r.status !== "persistence_failed") r.outcome = r.status;
    r.status = "persistence_failed";
    r.persistence = {
      status: "failed",
      error: {
        code: e.code ?? "PERSISTENCE_FAILED",
        message: String(e.message ?? error).slice(0, 2048),
      },
    };
    r.error = {
      code: "PERSISTENCE_FAILED",
      message: "Job evidence could not be saved; inspect VS, do not replay",
    };
    c.uncertain = true;
  }
  private async persist(c: Connection, r: Job) {
    r.persistence = { status: "pending" };
    try {
      await this.store.save({ ...r, persistence: { status: "saved" } });
      r.persistence = { status: "saved" };
    } catch (e) {
      this.persistenceFailure(c, r, e);
      throw e;
    }
  }
  async jobStatus(owner: Owner, raw: unknown) {
    const p = object(raw, ["jobId"]);
    const a = this.active.get(p.jobId);
    if (a) {
      if (a.record.owner.sessionId !== owner.sessionId)
        fail("FOREIGN_JOB", "Foreign task");
      return structuredClone(a.record);
    }
    const retained = this.completed.get(p.jobId);
    if (retained) {
      if (retained.owner.sessionId !== owner.sessionId)
        fail("FOREIGN_JOB", "Foreign task");
      return structuredClone(retained);
    }
    return this.store.read(p.jobId, owner);
  }
  async cancel(owner: Owner, raw: unknown) {
    const p = object(raw, ["jobId"]);
    const a = this.active.get(p.jobId);
    if (!a) return this.jobStatus(owner, p);
    if (a.record.owner.sessionId !== owner.sessionId)
      fail("FOREIGN_JOB", "Foreign task");
    a.controller.abort(new Error("Automation cancelled; debuggee not stopped"));
    await a.done;
    return structuredClone(a.record);
  }
  async listJobs(owner: Owner, raw: unknown = {}) {
    const p = object(raw, ["limit", "offset", "requestId"]);
    const limit = p.limit ?? 20,
      offset = p.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 4096 ||
      (p.requestId !== undefined &&
        (typeof p.requestId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(p.requestId)))
    )
      fail("INVALID_INPUT", "Invalid job list filter");
    const jobs = new Map<string, Job>();
    let storageError: { code: string; message: string } | undefined;
    try {
      for (const job of await this.store.list(owner)) jobs.set(job.jobId, job);
    } catch (error) {
      const e = error as Error & { code?: string };
      storageError = {
        code: e?.code ?? "STORAGE_UNAVAILABLE",
        message: String(e?.message ?? error).slice(0, 2048),
      };
    }
    for (const j of [
      ...this.completed.values(),
      ...[...this.active.values()].map((a) => a.record),
    ])
      if (j.owner.sessionId === owner.sessionId) jobs.set(j.jobId, j);
    const sorted = [...jobs.values()]
      .filter((j) => p.requestId === undefined || j.requestId === p.requestId)
      .sort(
        (a, b) =>
          (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
          a.jobId.localeCompare(b.jobId),
      );
    return {
      jobs: structuredClone(
        sorted
          .slice(offset, offset + limit)
          .map((j) => ({ ...j, steps: [], results: [] })),
      ),
      total: sorted.length,
      storageUnavailable: storageError !== undefined,
      incomplete: storageError !== undefined,
      ...(storageError ? { error: storageError } : {}),
      offset,
      limit,
      hasMore: offset + limit < sorted.length,
    };
  }
  async currentJob(owner: Owner) {
    const listed = await this.listJobs(owner, { limit: 1 });
    if (!listed.jobs.length && listed.storageUnavailable)
      fail(
        "STORAGE_UNAVAILABLE",
        "No in-memory task found; persisted tasks could not be listed",
      );
    return listed.jobs[0] ?? null;
  }
  async disconnect(owner: Owner) {
    if (!this.connections.has(key(owner))) {
      const old = [...this.connections.values()].filter(
        (c) => c.owner.sessionId === owner.sessionId,
      );
      for (const c of old) await this.disconnect(c.owner);
      return { disconnected: true, debuggeeStopped: false };
    }
    const c = this.connection(owner);
    return this.exclusive(c, async () => {
      try {
        await c.bridge.close();
      } finally {
        this.connections.delete(key(owner));
        targetLocks.delete(c.target.instanceId);
        for (const [id, p] of this.previews)
          if (same(p.owner, owner)) this.previews.delete(id);
      }
      return { disconnected: true, debuggeeStopped: false };
    });
  }
  async dispose() {
    this.closed = true;
    for (const a of this.active.values())
      a.controller.abort(new Error("Plugin disposed"));
    await Promise.allSettled(
      [...this.transient.keys()].map((bridge) => bridge.close()),
    );
    await Promise.allSettled([...this.transient.values()]);
    await Promise.allSettled([...this.pendingConnections.values()]);
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    for (const c of this.connections.values()) {
      await c.bridge.close();
      targetLocks.delete(c.target.instanceId);
    }
    this.connections.clear();
    this.previews.clear();
  }
}
