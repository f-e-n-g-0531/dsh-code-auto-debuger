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
  dynamic?: boolean;
};
type Preview = {
  owner: Owner;
  connection: Connection;
  target: Target;
  debugState: any;
  plan: Awaited<ReturnType<typeof validatePlan>>;
  expiresAt: number;
  investigation?: Investigation;
};
type DynamicJob = Job & {
  investigationId?: string;
  actionResult?: unknown;
  investigation?: any;
};
type Investigation = {
  record: DynamicJob;
  connection: Connection;
  revoked: boolean;
  controller?: AbortController;
  done?: Promise<DynamicJob>;
  requests: Map<string, { signature: string; result: Promise<string> }>;
};
type Active = { record: Job; controller: AbortController; done: Promise<void> };
export class DebugService {
  private connections = new Map<string, Connection>();
  private previews = new Map<string, Preview>();
  private active = new Map<string, Active>();
  private investigations = new Map<string, Investigation>();
  private currentInvestigations = new Map<string, string>();
  private sessionBudgets = new Map<
    string,
    {
      maxCalls: number;
      timeoutMs: number;
      expiresAt: number;
      actionsUsed: number;
    }
  >();
  private epochs = new Map<string, number>();
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
    private budgetOverride?: { maxCalls: number },
  ) {}
  capabilities() {
    return {
      version: "0.2.0",
      backendId: this.backendId,
      protocol: 1,
      features: { dynamicDebug: true, observerPanel: true, legacyBatch: true },
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
  private view(i: Investigation) {
    const v = structuredClone(i.record.investigation);
    v.authorized =
      !i.revoked && !this.closed && Date.now() < v.budget.expiresAt;
    if (!v.authorized && v.status === "active") v.status = "expired";
    return v;
  }
  private assertInvestigation(i: Investigation, owner: Owner) {
    if (!same(i.record.owner, owner))
      fail("FOREIGN_INVESTIGATION", "Foreign investigation/workspace");
    if (this.closed || i.revoked)
      fail("AUTHORIZATION_REVOKED", "Investigation authorization revoked");
    if (this.connection(owner) !== i.connection)
      fail("TARGET_CHANGED", "Connection changed");
    if (i.connection.uncertain)
      fail("RECONNECT_REQUIRED", "Previous outcome uncertain");
    const b = this.sessionBudgets.get(owner.sessionId);
    if (b && this.budgetOverride)
      b.maxCalls = this.budgetOverride.maxCalls;
    if (
      !b ||
      Date.now() >= i.record.investigation.budget.expiresAt ||
      Date.now() >= b.expiresAt ||
      b.actionsUsed >= b.maxCalls
    )
      fail("BUDGET_EXCEEDED", "Session automation budget exhausted");
  }
  async begin(owner: Owner, raw: unknown, signal?: AbortSignal) {
    const p = object(structuredClone(raw), [
      "goal",
      "confirmed",
      "allowEvaluation",
      "allowTerminate",
      "allowAttach",
      "processId",
    ]);
    if (p.confirmed !== true)
      fail(
        "CONFIRMATION_REQUIRED",
        "confirmed asserts explicit user authorization, not proof",
      );
    if (typeof p.goal !== "string" || !p.goal.trim() || p.goal.length > 4096)
      fail("INVALID_INPUT", "Investigation goal required");
    for (const n of ["allowEvaluation", "allowTerminate", "allowAttach"])
      if (p[n] !== undefined && typeof p[n] !== "boolean")
        fail("INVALID_INPUT", "Risk permissions must be booleans");
    if (
      p.allowAttach === true
        ? !Number.isSafeInteger(p.processId) || p.processId <= 0
        : p.processId !== undefined
    )
      fail("INVALID_INPUT", "Attach requires a fixed processId");
    const c = this.connection(owner),
      epoch = this.epochs.get(owner.sessionId) ?? 0;
    await this.authorize(owner);
    return this.exclusive(c, async () => {
      if (
        [...this.connections.values()].some(
          (x) => x !== c && x.owner.sessionId === owner.sessionId && x.busy,
        )
      )
        fail("BUSY", "Session task active");
      if (c.uncertain) fail("RECONNECT_REQUIRED", "Previous outcome uncertain");
      if (
        [...this.investigations.values()].some(
          (i) =>
            i.record.owner.sessionId === owner.sessionId &&
            this.view(i).authorized,
        )
      )
        fail(
          "INVESTIGATION_ACTIVE",
          "Take over before beginning another investigation",
        );
      this.pruneInvestigations();
      if (this.investigations.size >= 128)
        fail("CAPACITY", "Investigation retention capacity reached");
      const observation = await this.verified(c, signal);
      let attachTarget;
      if (p.allowAttach === true) {
        await this.authorize(owner);
        const process = await c.bridge.request(
          "processDescribe",
          { processId: p.processId },
          signal,
        );
        if (
          typeof process.startTime !== "string" ||
          !process.startTime ||
          (process.processId !== undefined && process.processId !== p.processId)
        )
          fail("TARGET_CHANGED", "Attach identity unavailable");
        attachTarget = { processId: p.processId, startTime: process.startTime };
      }
      signal?.throwIfAborted();
      if (this.closed || epoch !== (this.epochs.get(owner.sessionId) ?? 0))
        fail("AUTHORIZATION_REVOKED", "Authorization revoked while beginning");
      let budget = this.sessionBudgets.get(owner.sessionId);
      if (!budget || Date.now() >= budget.expiresAt) {
        budget = {
          maxCalls: this.budgetOverride?.maxCalls ?? 64,
          timeoutMs: 600000,
          expiresAt: Date.now() + 600000,
          actionsUsed: 0,
        };
        this.sessionBudgets.set(owner.sessionId, budget);
      }
      if (budget.actionsUsed >= budget.maxCalls)
        fail("BUDGET_EXCEEDED", "Session action budget exhausted");
      const id = randomUUID(),
        now = new Date().toISOString();
      const record: DynamicJob = {
        jobId: id,
        owner: structuredClone(owner),
        target: structuredClone(c.target),
        status: "succeeded",
        steps: [],
        results: [],
        createdAt: now,
        updatedAt: now,
        externalState: "last_observed_not_stopped",
        investigationId: id,
        investigation: {
          investigationId: id,
          status: "active",
          goal: p.goal.trim(),
          target: structuredClone(c.target),
          permissions: {
            allowEvaluation: p.allowEvaluation === true,
            allowTerminate: p.allowTerminate === true,
            allowAttach: p.allowAttach === true,
          },
          attachTarget,
          budget: { ...budget },
          actionsUsed: budget.actionsUsed,
          history: [],
          observation,
          backendId: this.backendId,
          authorizationAssertion:
            "confirmed is caller assertion of explicit user authorization, not independent proof",
        },
      };
      const i: Investigation = {
        record,
        connection: c,
        revoked: false,
        requests: new Map(),
      };
      this.investigations.set(id, i);
      this.currentInvestigations.set(owner.sessionId, id);
      c.dynamic = true;
      for (const [id, preview] of this.previews)
        if (preview.owner.sessionId === owner.sessionId)
          this.previews.delete(id);
      try {
        await this.persist(c, record);
      } catch (e) {
        i.revoked = true;
        throw e;
      }
      if (this.closed || epoch !== (this.epochs.get(owner.sessionId) ?? 0)) {
        i.revoked = true;
        fail("AUTHORIZATION_REVOKED", "Authorization revoked while beginning");
      }
      return this.view(i);
    });
  }
  async investigation(owner: Owner, raw: unknown = {}) {
    const p = object(raw, ["investigationId"]);
    const id =
      p.investigationId ?? this.currentInvestigations.get(owner.sessionId);
    if (id === undefined) {
      const latest = (await this.store.list(owner))
        .filter((j) => (j as DynamicJob).investigation?.investigationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return latest
        ? {
            ...structuredClone((latest as DynamicJob).investigation),
            status: "revoked",
            authorized: false,
          }
        : { status: "idle", authorized: false };
    }
    const i = this.investigations.get(id);
    if (i) {
      if (i.record.owner.sessionId !== owner.sessionId)
        fail("FOREIGN_INVESTIGATION", "Foreign investigation");
      return this.view(i);
    }
    const record = (await this.store.read(id, owner)) as DynamicJob;
    if (!record.investigation || record.investigationId !== id)
      fail("INVALID_INPUT", "Not an investigation");
    return {
      ...structuredClone(record.investigation),
      status: "revoked",
      authorized: false,
    };
  }
  async takeover(owner: Owner, raw: unknown = {}) {
    const p = object(raw, ["investigationId"]);
    if (p.investigationId !== undefined) {
      const i = this.investigations.get(p.investigationId);
      if (i && i.record.owner.sessionId !== owner.sessionId)
        fail("FOREIGN_INVESTIGATION", "Foreign investigation");
      if (!i) {
        this.revoke(owner.sessionId);
        return this.investigation(owner, p);
      }
    }
    this.revoke(owner.sessionId);
    await Promise.allSettled(
      [...this.investigations.values()]
        .filter((i) => i.record.owner.sessionId === owner.sessionId)
        .map((i) => i.done),
    );
    this.pruneInvestigations();
    return this.investigation(owner, p);
  }
  private inactiveInvestigation(i: Investigation) {
    return (
      !this.view(i).authorized &&
      !i.connection.busy &&
      !i.controller &&
      !i.done
    );
  }
  private pruneInvestigations() {
    const inactive = [...this.investigations.entries()].filter(([, i]) =>
      this.inactiveInvestigation(i),
    );
    while (this.investigations.size >= 128 && inactive.length) {
      const [id, i] = inactive.shift()!;
      this.investigations.delete(id);
      if (this.currentInvestigations.get(i.record.owner.sessionId) === id)
        this.currentInvestigations.delete(i.record.owner.sessionId);
    }
  }
  private revoke(sessionId: string) {
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1);
    for (const i of this.investigations.values())
      if (i.record.owner.sessionId === sessionId) {
        i.revoked = true;
        i.record.investigation.status = "revoked";
        i.controller?.abort(
          new Error("Automation revoked; debuggee not stopped"),
        );
      }
    for (const [id, p] of this.previews)
      if (p.owner.sessionId === sessionId) this.previews.delete(id);
    for (const a of this.active.values())
      if (a.record.owner.sessionId === sessionId)
        a.controller.abort(
          new Error("Automation revoked; debuggee not stopped"),
        );
  }
  async perform(
    owner: Owner,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<DynamicJob> {
    const p = object(structuredClone(raw), [
      "investigationId",
      "requestId",
      "action",
      "params",
    ]);
    if (
      typeof p.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(p.requestId)
    )
      fail("INVALID_INPUT", "requestId required");
    const i = this.investigations.get(p.investigationId);
    if (!i)
      fail("AUTHORIZATION_REVOKED", "Investigation not live on this backend");
    if (!same(i.record.owner, owner))
      fail("FOREIGN_INVESTIGATION", "Foreign investigation/workspace");
    const signature = JSON.stringify([p.action, p.params ?? {}]),
      prior = i.requests.get(p.requestId);
    if (prior) {
      if (prior.signature !== signature)
        fail("REQUEST_CONFLICT", "requestId parameters changed");
      const jobId = await prior.result;
      if (!jobId)
        fail("REQUEST_FAILED", "Original request failed; no automatic replay");
      return this.jobStatus(owner, { jobId });
    }
    this.assertInvestigation(i, owner);
    await this.authorize(owner);
    const permissions = i.record.investigation.permissions,
      budget = this.sessionBudgets.get(owner.sessionId)!,
      remaining = Math.min(300000, budget.expiresAt - Date.now());
    if (remaining < 100) fail("BUDGET_EXCEEDED", "Time budget exhausted");
    await validatePlan(
      {
        steps: [{ action: p.action, params: p.params ?? {} }],
        maxSteps: 1,
        timeoutMs: remaining,
        allowEvaluation: permissions.allowEvaluation,
        allowTerminate: permissions.allowTerminate,
      },
      owner.cwd,
    );
    this.idle(i.connection);
    if (i.requests.size >= 1024)
      fail(
        "CAPACITY",
        "Request retention capacity reached; no replay permitted",
      );
    let accept: (jobId: string) => void;
    const accepted = new Promise<string>((resolve) => {
      accept = resolve;
    });
    i.requests.set(p.requestId, { signature, result: accepted });
    const work = this.performNew(i, owner, p, signal);
    i.done = work;
    void work.then(
      (record) => {
        if (record.status === "queued" && record.error) {
          if (i.requests.get(p.requestId)?.result === accepted)
            i.requests.delete(p.requestId);
          accept!("");
          return;
        }
        accept!(record.jobId);
      },
      () => {
        // A request rejected before a job exists must not permanently occupy its ID.
        if (i.requests.get(p.requestId)?.result === accepted)
          i.requests.delete(p.requestId);
        accept!("");
      },
    );
    return work;
  }
  private async performNew(
    i: Investigation,
    owner: Owner,
    p: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<DynamicJob> {
    const c = i.connection;
    c.busy = true;
    const controller = new AbortController();
    i.controller = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let record: DynamicJob | undefined;
    try {
      const permissions = i.record.investigation.permissions,
        b = this.sessionBudgets.get(owner.sessionId)!;
      const remaining = Math.min(300000, b.expiresAt - Date.now());
      if (remaining < 100) fail("BUDGET_EXCEEDED", "Time budget exhausted");
      const plan = await validatePlan(
        {
          steps: [{ action: p.action, params: p.params ?? {} }],
          maxSteps: 1,
          timeoutMs: remaining,
          allowEvaluation: permissions.allowEvaluation,
          allowTerminate: permissions.allowTerminate,
        },
        owner.cwd,
      );
      if (p.action === "attach") {
        const attach = i.record.investigation.attachTarget;
        if (
          !permissions.allowAttach ||
          !attach ||
          plan.steps[0].params.processId !== attach.processId
        )
          fail(
            "RISK_NOT_AUTHORIZED",
            "Attach requires process identity fixed at begin",
          );
        plan.steps[0].params.expectedStartTime = attach.startTime;
      }
      this.assertInvestigation(i, owner);
      controller.signal.throwIfAborted();
      while (this.active.size + this.completed.size >= 128) {
        const evict = [...this.completed].find(
          ([, j]) => j.persistence?.status !== "failed",
        );
        if (!evict) fail("CAPACITY", "Retained task capacity reached");
        this.completed.delete(evict[0]);
      }
      b.actionsUsed++;
      i.record.investigation.budget = { ...b };
      i.record.investigation.actionsUsed = b.actionsUsed;
      const now = new Date().toISOString();
      record = {
        jobId: randomUUID(),
        owner: structuredClone(owner),
        target: structuredClone(c.target),
        status: "queued",
        steps: plan.steps,
        results: [],
        createdAt: now,
        updatedAt: now,
        externalState: "unconfirmed",
        requestId: p.requestId,
        investigationId: i.record.jobId,
      };
      i.record.investigation.lastJobId = record.jobId;
      const history = {
        jobId: record.jobId,
        action: p.action,
        status: "queued",
        observedAt: now,
      };
      i.record.investigation.history.push(history);
      await this.persist(c, i.record);
      controller.signal.throwIfAborted();
      const preview: Preview = {
        owner,
        connection: c,
        target: c.target,
        debugState: {},
        plan,
        expiresAt: b.expiresAt,
        investigation: i,
      };
      const active: Active = { record, controller, done: Promise.resolve() };
      this.active.set(record.jobId, active);
      active.done = this.run(c, preview, active);
      await active.done;
      history.status = record.status;
      history.observedAt = record.updatedAt;
      record.actionResult = record.results[0]?.value;
      i.record.investigation.lastAction = p.action;
      i.record.investigation.lastEvidence = record.results[0];
      if (c.uncertain) {
        i.revoked = true;
        i.record.investigation.status = "uncertain";
      }
      i.record.updatedAt = new Date().toISOString();
      await this.persist(c, record);
      await this.persist(c, i.record);
      return structuredClone(record);
    } catch (e) {
      if (c.uncertain) {
        i.revoked = true;
        i.record.investigation.status = "uncertain";
      }
      if (record) {
        if (c.uncertain && record.persistence?.status !== "failed") {
          const notStarted = record.status === "queued";
          this.persistenceFailure(c, record, e);
          if (notStarted) record.outcome = "not_started";
        } else if (record.status === "queued") {
          record.status = controller.signal.aborted ? "cancelled" : "failed";
          record.error = {
            code: controller.signal.aborted ? "CANCELLED" : "DEBUG_FAILED",
            message: String((e as Error).message ?? e).slice(0, 2048),
          };
          record.updatedAt = new Date().toISOString();
          try {
            await this.persist(c, record);
          } catch {
            /* In-memory failure evidence retained. */
          }
        }
        const history = i.record.investigation.history.find(
          (h: any) => h.jobId === record!.jobId,
        );
        if (history) {
          history.status = record.status;
          history.observedAt = record.updatedAt;
        }
        return structuredClone(record);
      }
      throw e;
    } finally {
      c.busy = false;
      i.controller = undefined;
      i.done = undefined;
      signal?.removeEventListener("abort", abort);
      if (record) {
        this.active.delete(record.jobId);
        this.completed.set(record.jobId, record);
      }
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
    if (c.dynamic)
      fail(
        "DYNAMIC_SESSION",
        "Use perform; legacy plans cannot bypass investigation permissions",
      );
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
    if (this.connections.get(key(owner))?.dynamic)
      fail("DYNAMIC_SESSION", "Legacy execute is isolated from investigations");
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
      p.investigation
        ? Math.max(1, Math.min(p.plan.timeoutMs, p.expiresAt - Date.now()))
        : p.plan.timeoutMs,
    );
    const signal = a.controller.signal;
    try {
      await this.persist(c, r);
      signal.throwIfAborted();
      const current = await this.verified(c, signal);
      if (p.investigation) {
        const view = p.investigation.record.investigation;
        const expected = view.observation?.debuggees ?? [];
        const launching = view.lastAction === "launch" && expected.length === 0;
        if (!launching && !same(current.debuggees ?? [], expected))
          fail(
            "TARGET_CHANGED",
            "Debuggee identity changed since last authorized observation",
          );
        view.observation = structuredClone(current);
      }
      if (
        !p.investigation &&
        (current.state !== p.debugState.state ||
          !same(current.debuggees ?? [], p.debugState.debuggees ?? []))
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
        if (
          p.investigation &&
          (p.investigation.revoked || this.closed || Date.now() >= p.expiresAt)
        )
          fail(
            "AUTHORIZATION_REVOKED",
            "Investigation authorization expired or revoked",
          );
        if (p.investigation && s.action === "attach") {
          const process = await c.bridge.request(
            "processDescribe",
            { processId: s.params.processId },
            signal,
          );
          if (process.startTime !== s.params.expectedStartTime)
            fail("TARGET_CHANGED", "Attach PID was reused");
        }
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
          if (p.investigation)
            p.investigation.record.investigation.observation =
              structuredClone(after);
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
    this.revoke(owner.sessionId);
    const pending = [...this.active.values()].filter(
      (a) => a.record.owner.sessionId === owner.sessionId,
    );
    await Promise.allSettled([
      ...pending.map((a) => a.done),
      ...[...this.investigations.values()]
        .filter((i) => i.record.owner.sessionId === owner.sessionId)
        .map((i) => i.done),
    ]);
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
    for (const i of this.investigations.values())
      this.revoke(i.record.owner.sessionId);
    for (const a of this.active.values())
      a.controller.abort(new Error("Plugin disposed"));
    await Promise.allSettled(
      [...this.transient.keys()].map((bridge) => bridge.close()),
    );
    await Promise.allSettled([...this.transient.values()]);
    await Promise.allSettled([...this.pendingConnections.values()]);
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    await Promise.allSettled(
      [...this.investigations.values()].map((i) => i.done),
    );
    for (const c of this.connections.values()) {
      await c.bridge.close();
      targetLocks.delete(c.target.instanceId);
    }
    this.connections.clear();
    this.previews.clear();
  }
}
