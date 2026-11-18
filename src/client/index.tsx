import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRpc, errorText, pretty, terminalJob } from "./protocol.js";
import type { Action, Connection, Data } from "./protocol.js";
import { createJobStore, sessionKey } from "./job-store.js";
import type { JobStore } from "./job-store.js";
import { styles } from "./styles.js";

const uncertainJob = (value: Data | null) =>
  !value ||
  !(value.state ?? value.status) ||
  ["unknown", "interrupted", "persistence_failed"].includes(
    value.state ?? value.status,
  ) ||
  value.outcome === "unknown";
type Session = { id: string; cwd?: string };
type Rpc = ReturnType<typeof createRpc>;
export const name = "@feng0531/dsh-code-auto-debuger";
export const inject = ["slots", "connection"];
export function apply(ctx: { connection: Connection; slots: any }) {
  const rpc = createRpc(ctx.connection);
  // Survives slot remounts, without persisting session secrets in localStorage.
  const jobs = createJobStore();
  function Page(props: any) {
    const session = props.useSessions((state: any) =>
      Object.values(state.byId).find(
        (row: any) => (row.retainedBy.mainView ?? 0) > 0,
      ),
    ) as Session | undefined;
    return (
      <Panel
        key={JSON.stringify([session?.id, session?.cwd])}
        session={session}
        rpc={rpc}
        jobs={jobs}
      />
    );
  }
  function Icon() {
    return <span aria-hidden="true">◉</span>;
  }
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: "auto-debug" }, Page),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: "auto-debug",
        label: () => "自动调试",
        order: 68,
      },
      Icon,
    ),
  );
}
export default { name, inject, apply };

export function Panel({
  session,
  rpc,
  jobs,
}: {
  session?: Session;
  rpc: Rpc;
  jobs: JobStore;
}) {
  const key = sessionKey(session);
  const saved = useSyncExternalStore(
    jobs.subscribe,
    () => jobs.get(key),
    () => jobs.get(key),
  );
  const { jobId, job, unknown, requestId } = saved;
  const [recovered, setRecovered] = useState<Data[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [recoveryOffset, setRecoveryOffset] = useState(0);
  const [hasMoreJobs, setHasMoreJobs] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState("");
  const [instances, setInstances] = useState<Data[]>([]),
    [instanceId, setInstanceId] = useState("");
  const [solutionPath, setSolutionPath] = useState(""),
    [capabilities, setCapabilities] = useState<Data | null>(null);
  const [status, setStatus] = useState<Data | null>(null),
    [snapshot, setSnapshot] = useState<Data | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [investigation, setInvestigation] = useState<Data | null>(null);
  const mounted = useRef(true),
    lock = useRef(false);
  const operation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const observationVersion = useRef(0);
  const [pollGeneration, restartPoll] = useState(0);
  const [observationError, setObservationError] = useState("");
  const takeoverLock = useRef(false);
  const [takingOver, setTakingOver] = useState(false);
  const [takeoverError, setTakeoverError] = useState("");
  const [evidenceJob, setEvidenceJob] = useState<Data | null>(null);
  const persist = (id: string, value: Data | null, uncertain: boolean) => {
    if (session)
      jobs.set(key, {
        jobId: id,
        job: value,
        unknown: uncertain,
        requestId: jobs.get(key).requestId,
      });
  };
  const protocol = useRef<Data | null>(null);
  const compatible = (value: Data | null | undefined) =>
    value?.version === "0.1.8" &&
    value?.protocol === 1 &&
    value?.features?.dynamicDebug === true;
  const ensureProtocol = async () => {
    if (compatible(protocol.current)) return protocol.current;
    if (protocol.current) {
      throw new Error(
        "前后端协议不匹配（需要 version 0.1.8 / protocol 1 / dynamicDebug），已禁止连接；请更新并重新读取能力",
      );
    }
    return handshake();
  };
  const call = async (action: Action, args: Data = {}) => {
    if (!session?.id) throw new Error("请先选择 DSH 会话。");
    // Every control, including observation and takeover, must reject a stale backend.
    if (action !== "capabilities") await ensureProtocol();
    return rpc(action, session.id, args);
  };
  async function handshake() {
    if (!session?.id) throw new Error("请先选择 DSH 会话。");
    const value = await rpc("capabilities", session.id);
    if (!compatible(value)) {
      protocol.current = value ?? { incompatible: true };
      if (mounted.current) {
        setCapabilities(null);
        setStatus(null);
      }
      throw new Error(
        "前后端协议不匹配（需要 version 0.1.8 / protocol 1 / dynamicDebug），已禁止连接；请更新并重新读取能力",
      );
    }
    protocol.current = value;
    if (mounted.current) setCapabilities(value);
    return value;
  }
  async function recoverJobs(offset = 0, all = false) {
    if (!session?.id) return;
    setRecovering(true);
    try {
      const current = jobs.get(key);
      const value = await call("listJobs", {
        limit: 50,
        offset,
        ...(!all && current.requestId ? { requestId: current.requestId } : {}),
      });
      if (!Array.isArray(value?.jobs)) throw new Error("后台任务列表不可识别");
      if (mounted.current)
        setRecoveryWarning(
          value.storageUnavailable || value.incomplete
            ? "后台任务存储不可用或列表不完整；未列出任务不证明未执行。请保留原请求标识并稍后重新查询，勿重复提交。"
            : "",
        );
      if (
        current.requestId &&
        !all &&
        !value.jobs.some((row: Data) => row.requestId === current.requestId)
      ) {
        if (mounted.current) {
          setRecovered([]);
          setHasMoreJobs(false);
          setRecoveryOffset(offset);
          setNotice(
            "未找到匹配任务；不证明原请求未执行。可再次查询或明确选择原任务。",
          );
        }
        return;
      }
      if (mounted.current) {
        setRecovered(value.jobs);
        setRecoveryOffset(offset);
        setHasMoreJobs(value.hasMore === true);
      }
      // An unresolved requestId may only bind its own job. A same-cwd row is a different task.
      const match = current.requestId
        ? value.jobs.find((row: Data) => row.requestId === current.requestId)
        : undefined;
      if (match && jobs.get(key) === current) {
        jobs.set(key, {
          jobId: match.jobId,
          job: match,
          unknown: current.unknown || uncertainJob(match),
          requestId: match.requestId || current.requestId,
        });
      }
      if (mounted.current && (match || current.requestId || all))
        setNotice(
          match
            ? "已从后台恢复原任务，未重发执行。"
            : "未找到匹配任务；不证明原请求未执行。可再次查询或明确选择原任务。",
        );
    } finally {
      if (mounted.current) setRecovering(false);
    }
  }
  useEffect(() => {
    let live = true;
    void recoverJobs().catch((cause) => {
      if (live) setError("恢复任务失败，可手动重新查询：" + errorText(cause));
    });
    return () => {
      live = false;
    };
  }, [key]);
  async function run(label: string, work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    const token = ++operation.current;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      if (operation.current === token) {
        lock.current = false;
        if (mounted.current) setBusy("");
      }
    }
  }

  async function refreshInvestigation() {
    const version = ++observationVersion.current;
    const value = await call("investigation");
    if (
      mounted.current &&
      !takeoverLock.current &&
      version === observationVersion.current
    ) {
      setInvestigation(value);
      setObservationError("");
      restartPoll((n) => n + 1);
    }
  }
  useEffect(() => {
    if (!session?.id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const version = observationVersion.current;
        await ensureProtocol();
        const value = await rpc(
          "investigation",
          session.id,
          {},
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!takeoverLock.current && version === observationVersion.current) {
          setInvestigation(value);
          setObservationError("");
        }
        timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (!controller.signal.aborted)
          setObservationError("调查观察中断，请手动刷新：" + errorText(cause));
        return;
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, rpc, capabilities, pollGeneration]);
  const evidenceJobId = investigation?.lastJobId;
  const evidenceRevision = investigation?.history?.at(-1);
  useEffect(() => {
    setEvidenceJob(null);
    if (!session?.id || !evidenceJobId) return;
    const controller = new AbortController();
    void ensureProtocol()
      .then(() =>
        rpc(
          "jobStatus",
          session.id,
          { jobId: evidenceJobId },
          controller.signal,
        ),
      )
      .then(
        (value) => {
          if (!controller.signal.aborted) setEvidenceJob(value);
        },
        (cause) => {
          if (!controller.signal.aborted)
            setError("读取调查证据失败：" + errorText(cause));
        },
      );
    return () => controller.abort();
  }, [
    key,
    rpc,
    investigation?.backendId,
    evidenceJobId,
    evidenceRevision?.status,
    evidenceRevision?.observedAt,
    pollGeneration,
  ]);
  async function takeover() {
    if (takeoverLock.current) return;
    takeoverLock.current = true;
    setTakingOver(true);
    setTakeoverError("");
    ++observationVersion.current;
    try {
      // Revocation must not wait for a snapshot, refresh, or history request.
      const value = await call("takeover");
      if (!mounted.current) return;
      ++observationVersion.current;
      setInvestigation(value?.investigation ?? value);
      setObservationError("");
      restartPoll((n) => n + 1);
      setNotice(
        "已请求撤销调查并取消活动任务。接管不是暂停或终止目标进程，也不会回滚已发生的操作；请在 Visual Studio 核对。",
      );
    } catch (cause) {
      if (mounted.current)
        setTakeoverError("未能确认接管：" + errorText(cause));
    } finally {
      takeoverLock.current = false;
      if (mounted.current) setTakingOver(false);
    }
  }
  const connected =
    !!status?.target &&
    ["connected", "running", "break", "design"].includes(status?.state);
  const active = !!jobId && !!job && !terminalJob(job);
  const blocked = !!busy || !session || active || unknown || (!!jobId && !job);
  async function refreshStatus() {
    const value = await call("status");
    if (mounted.current) setStatus(value);
  }
  async function refreshJob() {
    const value = await call("jobStatus", { jobId });
    if (unknown && requestId && value.requestId !== requestId)
      throw new Error("任务与原请求不匹配，保留未知结果屏障。");
    persist(
      jobId,
      value,
      uncertainJob(value) ||
        (unknown && !(terminalJob(value) && value.requestId === requestId)),
    );
  }
  // Read-only polling never occupies the mutation lock, so cancellation stays usable.
  useEffect(() => {
    if (!session?.id || !jobId || !job || terminalJob(job) || busy || unknown)
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await rpc(
          "jobStatus",
          session.id,
          { jobId },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        persist(
          jobId,
          value,
          uncertainJob(value) ||
            (unknown && !(terminalJob(value) && value.requestId === requestId)),
        );
        if (!terminalJob(value)) timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          persist(jobId, job, true);
          setError(
            "任务状态连接中断，结果未知；自动查询已停止，请手动查询原任务。" +
              errorText(cause),
          );
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, jobId, terminalJob(job), busy, unknown]);
  const stack = snapshot?.stack ?? snapshot?.stackFrames ?? snapshot?.frames;
  const hasInvestigation = Boolean(
    investigation?.status && investigation.status !== "idle",
  );
  const statusLabel =
    new Map([
      ["active", "调查中"],
      ["revoked", "授权已撤销"],
      ["expired", "授权已到期"],
      ["uncertain", "结果未确认"],
    ]).get(investigation?.status) ?? investigation?.status;
  const lastAction =
    investigation?.lastAction ?? investigation?.history?.at(-1)?.action;
  const actionLabel = new Map([
    ["snapshot", "读取快照"],
    ["waitForBreak", "等待断点"],
    ["breakpointAdd", "设置断点"],
    ["breakpointRemove", "移除断点"],
    ["launch", "启动"],
    ["continue", "继续运行"],
    ["pause", "暂停"],
    ["step", "单步"],
    ["attach", "附加进程"],
    ["detach", "分离进程"],
    ["evaluate", "求值"],
    ["terminate", "终止"],
  ]);
  const evidence =
    evidenceJob?.results ??
    investigation?.lastEvidence ??
    investigation?.evidence;
  const example =
    "请帮我定位当前解决方案的启动崩溃。复现方式是【填写实际步骤】。只调试这个工程；允许启动、设置断点和单步，不修改源码、不附加进程、不求值、不终止程序。请说明定位证据和仍未确认的假设。";
  return (
    <section className="ad-root">
      <style>{styles}</style>
      <header>
        <div>
          <p className="ad-eyebrow">DSH · Visual Studio</p>
          <h1>自动调试</h1>
        </div>
        <span className="ad-badge">观察调查 · 随时接管</span>
      </header>
      <div aria-live="polite">
        {busy && <p role="status">{busy}…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="ad-warning" role="alert">
            {error}。不可用不代表操作成功；请核对状态，不自动重试。
          </p>
        )}
      </div>
      {!session && <p role="alert">请先打开一个 DSH 对话并选好工程目录。</p>}
      {session &&
        !unknown &&
        investigation?.status !== "uncertain" &&
        investigation?.status !== "active" && (
          <section className="ad-card ad-start">
            <h2>在对话中开始调试</h2>
            <p>
              在 Visual Studio 打开目标解决方案。在当前 DSH
              对话里说清楚问题、复现方式和允许的操作，不用手写调试计划。
            </p>
            <blockquote>{example}</blockquote>
            <button
              className="ad-primary"
              onClick={async () => {
                try {
                  await globalThis.navigator.clipboard.writeText(example);
                  if (mounted.current)
                    setNotice("已复制。回到对话修改示例后再发送。");
                } catch {
                  if (mounted.current)
                    setNotice("无法访问剪贴板，请手动选中并复制上方示例。");
                }
              }}
            >
              复制对话示例
            </button>
          </section>
        )}
      {(unknown || investigation?.status === "uncertain") && (
        <p className="ad-warning" role="alert">
          原任务结果未确认。请展开「任务恢复与历史」核对原任务和 Visual
          Studio，不要重新提交。
        </p>
      )}
      <section className="ad-card">
        <h2>当前调查</h2>
        <button
          disabled={!!busy || !session}
          onClick={() => void run("刷新调查", refreshInvestigation)}
        >
          刷新调查
        </button>
        {!hasInvestigation && (
          <p>
            {investigation?.status === "idle"
              ? "当前没有调查。请在对话中描述问题。"
              : "尚未读到调查状态。"}
          </p>
        )}
        {hasInvestigation && (
          <>
            <dl className="ad-overview">
              <dt>调查目标</dt>
              <dd>
                {typeof investigation?.goal === "string"
                  ? investigation.goal
                  : "未提供"}
              </dd>
              <dt>调查状态</dt>
              <dd>{statusLabel}（后台自报，非独立验收）</dd>
              <dt>已用操作</dt>
              <dd>
                {investigation?.actionsUsed ?? "未提供"}
                {typeof investigation?.budget?.maxCalls === "number"
                  ? " / " + investigation.budget.maxCalls
                  : ""}
              </dd>
              <dt>最近操作</dt>
              <dd>
                {typeof lastAction === "string"
                  ? (actionLabel.get(lastAction) ?? lastAction)
                  : "尚无记录"}
              </dd>
            </dl>
            {evidence !== undefined && (
              <details className="ad-fold ad-evidence">
                <summary>查看最近一次调试证据</summary>
                <pre>{pretty(evidence)}</pre>
              </details>
            )}
            <details className="ad-fold ad-evidence">
              <summary>查看调查详情与完整操作记录</summary>
              <pre>{pretty(investigation)}</pre>
            </details>
          </>
        )}
        <button
          disabled={takingOver || !session}
          onClick={() => void takeover()}
        >
          停止 AI 后续调试 / 手动接管
        </button>
        {takingOver && <p role="status">正在等待后台确认接管…</p>}
        {takeoverError && (
          <p role="alert" className="ad-warning">
            {takeoverError}
          </p>
        )}
        {observationError && (
          <p role="alert" className="ad-warning">
            {observationError}
          </p>
        )}
        <p className="ad-warning">
          接管会撤销调查授权并请求取消活动任务，不是暂停、终止进程或回滚。正在执行的操作可能已经产生副作用；请核对
          VS。
        </p>
      </section>
      <details className="ad-card ad-fold">
        <summary>手动连接 Visual Studio</summary>
        <p className="ad-hint">
          仅在对话中无法确认或连接到目标时使用。选择实例不会启动程序。
        </p>
        <p className="ad-hint">
          会话：{session?.id || "未选择"} · 工作区：{session?.cwd || "未提供"}
        </p>
        <div className="ad-actions">
          <button
            disabled={!!busy || !session}
            onClick={() =>
              void run("读取能力", async () => {
                await handshake();
              })
            }
          >
            读取能力声明
          </button>
          <button
            disabled={!!busy || !session}
            onClick={() =>
              void run("发现实例", async () => {
                const value = await call("discover");
                const rows = Array.isArray(value) ? value : value?.instances;
                if (!Array.isArray(rows)) throw new Error("实例列表不可识别。");
                setInstances(rows);
                setNotice(
                  rows.length
                    ? "请选择实例后点击连接。发现不等于连接。"
                    : "未发现可用实例；请检查本机 Visual Studio 与桥接器。",
                );
              })
            }
          >
            发现实例
          </button>
        </div>
        <label>
          Visual Studio 实例
          <select
            value={instanceId}
            disabled={blocked}
            onChange={(event) => {
              setInstanceId(event.target.value);
              setStatus(null);
            }}
          >
            <option value="">明确选择实例</option>
            {instances.map((row) => (
              <option
                key={row.instanceId || row.id}
                value={row.instanceId || row.id}
              >
                {row.displayName || row.name || row.instanceId || row.id}
                {row.solutionPath ? " · " + row.solutionPath : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          解决方案绝对路径
          <input
            value={solutionPath}
            disabled={blocked}
            placeholder="G:\project\Project.sln"
            onChange={(event) => {
              setSolutionPath(event.target.value);
              setStatus(null);
            }}
          />
        </label>
        <div className="ad-actions">
          <button
            disabled={blocked || !instanceId || !solutionPath.trim()}
            onClick={() =>
              void run("连接实例", async () => {
                setStatus(null);
                await call("connect", {
                  instanceId,
                  solutionPath: solutionPath.trim(),
                });
                await refreshStatus();
              })
            }
          >
            明确连接所选实例
          </button>
          <button
            disabled={!!busy || !session || active || unknown}
            onClick={() =>
              void run("断开连接", async () => {
                await call("disconnect");
                jobs.set(key, {
                  jobId: "",
                  job: null,
                  unknown: false,
                  requestId: "",
                });
                setStatus(null);
                setSnapshot(null);
                setNotice(
                  "已断开自动化连接；不证明目标停止。请在 VS 核对实际状态后再明确连接。",
                );
              })
            }
          >
            断开连接
          </button>
          <button
            disabled={!!busy || !session}
            onClick={() => void run("查询状态", refreshStatus)}
          >
            刷新状态
          </button>
        </div>
        <p role="status">
          {status
            ? "状态已读取（后台自报，非独立验收）"
            : "状态尚未验证；能力与连接状态未知。"}
          {connected ? " · 后台报告已连接" : ""}
        </p>
        {status && <pre>{pretty(status)}</pre>}
        <details>
          <summary>能力声明（不等于现场验证）</summary>
          <pre>
            {capabilities
              ? pretty(capabilities)
              : "尚未读取；不可据此认定任何能力可用。"}
          </pre>
        </details>
      </details>
      <details className="ad-card ad-fold">
        <summary>任务恢复与历史</summary>
        {recoveryWarning && (
          <p role="alert" className="ad-warning">
            {recoveryWarning}
          </p>
        )}
        {busy && unknown && (
          <button
            onClick={() => {
              ++operation.current;
              lock.current = false;
              setBusy("");
              setNotice(
                "仅停止界面等待，不撤销后台执行；请查询原任务，禁止重复提交。",
              );
            }}
          >
            停止界面等待并查询原任务（不取消执行）
          </button>
        )}
        <p className="ad-hint">
          取消仅请求停止后续调度，不是强杀；已执行步骤不会回滚。未知结果不得自动重发。任务身份在当前插件实例内保留，刷新/重载后自动查询后台会话任务，也可显式恢复原任务；不会重新提交
          mutation。
        </p>
        <div className="ad-actions">
          <button
            disabled={!session || recovering}
            onClick={() =>
              void recoverJobs().catch((cause) => setError(errorText(cause)))
            }
          >
            从后台恢复会话任务
          </button>
          <button
            disabled={!session || recovering}
            onClick={() =>
              void recoverJobs(0, true).catch((cause) =>
                setError(errorText(cause)),
              )
            }
          >
            浏览全部会话任务
          </button>
          <button
            disabled={!session || recovering || recoveryOffset === 0}
            onClick={() =>
              void recoverJobs(Math.max(0, recoveryOffset - 50), true).catch(
                (cause) => setError(errorText(cause)),
              )
            }
          >
            上一页任务
          </button>
          <button
            disabled={!session || recovering || !hasMoreJobs}
            onClick={() =>
              void recoverJobs(recoveryOffset + 50, true).catch((cause) =>
                setError(errorText(cause)),
              )
            }
          >
            下一页任务
          </button>
        </div>
        <p className="ad-hint">
          请求标识：{requestId || "无"}
          。恢复查询不占执行锁；丢失响应时只查询原请求。
        </p>
        {recovered.length > 0 && (
          <label>
            后台会话任务（含原工作区）
            <select
              value=""
              onChange={(event) => {
                const row = recovered.find(
                  (item) => item.jobId === event.target.value,
                );
                if (
                  row &&
                  unknown &&
                  requestId &&
                  row.requestId !== requestId
                ) {
                  setError(
                    "原请求仍未确认，不能用其他任务覆盖未知结果；请查询原请求。",
                  );
                  return;
                }
                if (row)
                  jobs.set(key, {
                    jobId: row.jobId,
                    job: row,
                    unknown: uncertainJob(row),
                    requestId: row.requestId || "",
                  });
              }}
            >
              <option value="">明确选择要查询的原任务</option>
              {recovered.map((row) => (
                <option key={row.jobId} value={row.jobId}>
                  {row.jobId} · {row.owner?.cwd} · {row.status ?? row.state}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          任务 ID（可从后台记录恢复）
          <input
            value={jobId}
            disabled={!!busy || active || (!!requestId && unknown)}
            onChange={(event) => {
              persist(event.target.value, null, true);
            }}
          />
        </label>
        <div className="ad-actions">
          <button
            disabled={!!busy || !session || !jobId.trim()}
            onClick={() => void run("查询任务", refreshJob)}
          >
            查询任务进度
          </button>
          <button
            disabled={
              !!busy || !session || !jobId || (terminalJob(job) && !unknown)
            }
            onClick={() =>
              void run("请求取消", async () => {
                const value = await call("cancel", { jobId });
                const settled = terminalJob(value) && !uncertainJob(value);
                setNotice(
                  settled
                    ? "取消请求已返回终态，不证明目标进程停止；请在 Visual Studio 核对。"
                    : "取消请求已返回，结果仍未确认，不证明目标进程停止；请查询原任务。",
                );
                persist(jobId, value, !settled);
              })
            }
          >
            请求取消任务
          </button>
        </div>
        {job && (
          <>
            <p role="status">
              后台状态：{String(job.state ?? job.status ?? "未知")} ·{" "}
              {job.completedSteps ??
                job.progress?.completed ??
                job.results?.length ??
                "—"}{" "}
              /{" "}
              {job.totalSteps ??
                job.progress?.total ??
                job.steps?.length ??
                "—"}{" "}
              步
            </p>
            <pre>{pretty(job)}</pre>
          </>
        )}
        {unknown && jobId && terminalJob(job) && (
          <button
            disabled={!!busy}
            onClick={() =>
              void run("明确恢复连接", async () => {
                await call("disconnect");
                jobs.set(key, {
                  jobId: "",
                  job: null,
                  unknown: false,
                  requestId: "",
                });
                setStatus(null);
                setSnapshot(null);
                setNotice(
                  "已明确断开旧连接；不证明原副作用回滚。请核对 VS 后重新连接，旧任务仍可从后台查询。",
                );
              })
            }
          >
            已核对 VS，明确断开旧连接以恢复流程
          </button>
        )}
        {unknown && (
          <p className="ad-warning" role="alert">
            结果未知或未确认。请查询原任务并核对 Visual
            Studio，不能将中断视为失败或回滚。若任务身份丢失，需由宿主恢复记录，不可通过重新提交试探。
          </p>
        )}
      </details>
      <details className="ad-card ad-fold">
        <summary>手动读取调试快照</summary>
        <div className="ad-actions">
          <button
            disabled={!!busy || !session}
            onClick={() =>
              void run("读取快照", async () => {
                setSnapshot(null);
                setSnapshot(await call("snapshot"));
              })
            }
          >
            读取只读快照
          </button>
        </div>
        <p className="ad-hint">
          快照仅代表采集时刻；未提供、不可用或未知字段不会补成成功。
        </p>
        {Array.isArray(stack) && stack.length > 0 && (
          <ol className="ad-stack">
            {stack.map((frame: Data, index: number) => (
              <li key={index}>
                <strong>
                  {frame.functionName ||
                    frame.name ||
                    frame.function ||
                    "函数未知"}
                </strong>
                <span>
                  {frame.file || frame.fileName || "文件未知"}:
                  {frame.line ?? frame.lineNumber ?? "?"}
                </span>
              </li>
            ))}
          </ol>
        )}
        <pre>{snapshot ? pretty(snapshot) : "尚无可用快照。"}</pre>
      </details>
    </section>
  );
}
