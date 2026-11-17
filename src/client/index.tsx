import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createRpc,
  errorText,
  parsePlan,
  pretty,
  terminalJob,
} from "./protocol.js";
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
  const [draft, setDraft] = useState(
    JSON.stringify([{ action: "snapshot", params: {} }], null, 2),
  );
  const [maxSteps, setMaxSteps] = useState(8),
    [timeoutMs, setTimeoutMs] = useState(30000);
  const [preview, setPreview] = useState<Data | null>(null),
    [consent, setConsent] = useState(false),
    [now, setNow] = useState(Date.now());
  const [file, setFile] = useState(""),
    [line, setLine] = useState(1);
  const mounted = useRef(true),
    lock = useRef(false);
  const operation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [preview]);
  const persist = (id: string, value: Data | null, uncertain: boolean) => {
    if (session)
      jobs.set(key, {
        jobId: id,
        job: value,
        unknown: uncertain,
        requestId: jobs.get(key).requestId,
      });
  };
  const invalidate = () => {
    setPreview(null);
    setConsent(false);
  };
  const call = async (action: Action, args: Data = {}) => {
    if (!session?.id) throw new Error("请先选择 DSH 会话。");
    if (["connect", "preview", "execute"].includes(action)) await handshake();
    return rpc(action, session.id, args);
  };
  async function handshake() {
    if (!session?.id) throw new Error("请先选择 DSH 会话。");
    const value = await rpc("capabilities", session.id);
    if (value?.version !== "0.1.2" || value?.protocol !== 1) {
      if (mounted.current) {
        setCapabilities(null);
        setStatus(null);
        invalidate();
      }
      throw new Error(
        "前后端协议不匹配（需要 version 0.1.2 / protocol 1），已禁止连接与执行；请更新并重新读取能力",
      );
    }
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
      if (mounted.current) {
        setRecovered(value.jobs);
        setRecoveryOffset(offset);
        setHasMoreJobs(value.hasMore === true);
        setRecoveryWarning(
          value.storageUnavailable || value.incomplete
            ? "后台任务存储不可用或列表不完整；未列出任务不证明未执行。请保留原请求标识并稍后重新查询，勿重复提交。"
            : "",
        );
      }
      // Correlation wins over cwd: the same session may have moved while execute was pending.
      const match = current.requestId
        ? value.jobs.find((row: Data) => row.requestId === current.requestId)
        : value.jobs.find((row: Data) => row.owner?.cwd === session.cwd);
      if (match && jobs.get(key) === current) {
        jobs.set(key, {
          jobId: match.jobId,
          job: match,
          unknown: uncertainJob(match),
          requestId: match.requestId || current.requestId,
        });
      }
      if (mounted.current)
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
  const expiredAt =
    preview?.expiresAt == null
      ? NaN
      : typeof preview.expiresAt === "number"
        ? preview.expiresAt
        : Date.parse(preview.expiresAt);
  const expired = Number.isFinite(expiredAt) && now >= expiredAt;
  const active = !!jobId && !!job && !terminalJob(job);
  const foreignCwd = !!job?.owner?.cwd && job.owner.cwd !== session?.cwd;
  const blocked =
    !!busy || !session || active || unknown || foreignCwd || (!!jobId && !job);
  const connected =
    !!status?.target &&
    ["connected", "running", "break", "design"].includes(status?.state);
  function append(action: string, params: Data = {}) {
    try {
      const plan =
        draft.trim() === "[]"
          ? { steps: [] }
          : parsePlan(draft, maxSteps, timeoutMs);
      if (plan.steps.length >= maxSteps)
        throw new Error("已达到计划最大步数。");
      setDraft(pretty([...plan.steps, { action, params }]));
      invalidate();
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  async function refreshStatus() {
    try {
      const value = await call("status");
      if (mounted.current) {
        setStatus(value);
        invalidate();
      }
    } catch (cause) {
      if (mounted.current) setStatus(null);
      throw cause;
    }
  }
  async function refreshJob() {
    const value = await call("jobStatus", { jobId });
    if (unknown && requestId && value.requestId !== requestId)
      throw new Error("任务与原请求不匹配，保留未知结果屏障。");
    persist(jobId, value, uncertainJob(value));
  }
  async function execute() {
    if (!preview?.previewId || !consent || expired || blocked) return;
    const previewId = preview.previewId;
    invalidate();
    // Set an uncertainty barrier BEFORE sending: a transport failure cannot authorize replay.
    await handshake();
    const correlation = globalThis.crypto.randomUUID();
    jobs.set(key, {
      jobId: "",
      job: null,
      unknown: true,
      requestId: correlation,
    });
    // Snapshot identity is a generation token; recovery/status writes supersede this submission.
    const submittedSnapshot = jobs.get(key);
    try {
      const value = await rpc("execute", session!.id, {
        previewId,
        confirmed: true,
        requestId: correlation,
      });
      const id = value?.jobId || value?.job?.jobId || "";
      if (jobs.get(key) !== submittedSnapshot) return;
      persist(
        id,
        value?.job || value,
        !id || uncertainJob(value?.job || value),
      );
      if (mounted.current) {
        setStatus(null);
        setSnapshot(null);
        setNotice(
          id
            ? "已提交任务。请查询进度；提交成功不代表调试步骤成功。"
            : "后台未返回任务身份，执行结果未知。请勿重复执行。",
        );
      }
    } catch (cause) {
      if (mounted.current)
        setNotice(
          "执行响应未确认：可能已产生调试副作用。禁止自动重发；请保留当前会话，查询后台任务并核对 Visual Studio。",
        );
      throw cause;
    }
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
        persist(jobId, value, uncertainJob(value));
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
  return (
    <section className="ad-root">
      <style>{styles}</style>
      <header>
        <div>
          <p className="ad-eyebrow">DSH · Visual Studio</p>
          <h1>自动调试</h1>
        </div>
        <span className="ad-badge">有限计划 · 明确确认</span>
      </header>
      <p className="ad-hint">
        仅连接你明确选择的实例。调试控制只能先预览、再确认执行；不自动安装桥接器、不自动重试未知结果。
      </p>
      {!session && <p role="alert">当前没有活动 DSH 会话，操作不可用。</p>}
      <div className="ad-grid">
        <section className="ad-card">
          <h2>1 · 实例与连接</h2>
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
                  if (!Array.isArray(rows))
                    throw new Error("实例列表不可识别。");
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
                invalidate();
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
                invalidate();
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
                  invalidate();
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
                  invalidate();
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
        </section>
        <section className="ad-card">
          <h2>2 · 编排有限调试计划</h2>
          <p className="ad-hint">
            下方快捷项仅加入草稿，不执行。宿主预览负责验证权限、实际能力、连接与参数。
          </p>
          <div className="ad-row">
            <label>
              断点文件
              <input
                value={file}
                disabled={blocked}
                onChange={(event) => setFile(event.target.value)}
              />
            </label>
            <label>
              行号
              <input
                type="number"
                min={1}
                value={line}
                disabled={blocked}
                onChange={(event) => setLine(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="ad-actions">
            <button
              disabled={
                blocked ||
                !file.trim() ||
                !Number.isSafeInteger(line) ||
                line < 1
              }
              onClick={() =>
                append("breakpointAdd", { file: file.trim(), line })
              }
            >
              加入断点
            </button>
            <button disabled={blocked} onClick={() => append("launch")}>
              加入启动
            </button>
            <button disabled={blocked} onClick={() => append("continue")}>
              加入继续
            </button>
            {(["over", "into", "out"] as const).map((kind, index) => (
              <button
                disabled={blocked}
                key={kind}
                onClick={() => append("step", { kind })}
              >
                {["加入逐过程", "加入逐语句", "加入跳出"][index]}
              </button>
            ))}
            <button
              disabled={blocked}
              onClick={() => {
                setDraft("[]");
                invalidate();
              }}
            >
              清空草稿
            </button>
          </div>
          <label>
            计划步骤 JSON
            <textarea
              spellCheck={false}
              rows={10}
              value={draft}
              disabled={blocked}
              onChange={(event) => {
                setDraft(event.target.value);
                invalidate();
              }}
            />
          </label>
          <div className="ad-row">
            <label>
              最大步骤（1–32）
              <input
                type="number"
                min={1}
                max={32}
                value={maxSteps}
                disabled={blocked}
                onChange={(event) => {
                  setMaxSteps(Number(event.target.value));
                  invalidate();
                }}
              />
            </label>
            <label>
              总超时（毫秒）
              <input
                type="number"
                min={1000}
                max={300000}
                value={timeoutMs}
                disabled={blocked}
                onChange={(event) => {
                  setTimeoutMs(Number(event.target.value));
                  invalidate();
                }}
              />
            </label>
          </div>
          <p className="ad-hint">
            此界面不授权表达式求值或终止进程；不提供 allowEvaluation /
            allowTerminate 绕过选项。
          </p>
          <button
            className="ad-primary"
            disabled={blocked || !connected}
            onClick={() =>
              void run("生成计划预览", async () => {
                invalidate();
                const args = parsePlan(draft, maxSteps, timeoutMs);
                if (
                  args.steps.some((step) =>
                    ["evaluate", "terminate"].includes(step.action),
                  )
                )
                  throw new Error("此界面不支持求值或终止进程授权。");
                const value = await call("preview", args);
                if (!value?.previewId)
                  throw new Error("后台未返回 previewId，不能执行。");
                setPreview(value);
                setNow(Date.now());
              })
            }
          >
            预览计划（不执行）
          </button>
          {!connected && (
            <p className="ad-hint">
              请先明确连接并成功读取 connected 状态；未连接时不能预览执行。
            </p>
          )}
        </section>
      </div>
      {preview && (
        <section className="ad-card ad-preview">
          <h2>3 · 审阅后台预览并确认</h2>
          <pre>{pretty(preview)}</pre>
          <p>
            {expired
              ? "预览已过期，请重新预览。"
              : Number.isFinite(expiredAt)
                ? "预览到期时间：" + new Date(expiredAt).toLocaleString()
                : "后台未提供有效到期时间；执行时由宿主重新校验。"}
          </p>
          <label className="ad-check">
            <input
              type="checkbox"
              checked={consent}
              disabled={blocked || expired}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我已核对实例、解决方案和每个步骤，确认执行此预览；理解调试操作可能改变目标状态且无法保证回滚。
          </label>
          <button
            className="ad-primary"
            disabled={blocked || expired || !consent}
            onClick={() => void run("执行已确认计划", execute)}
          >
            确认并执行此预览
          </button>
        </section>
      )}
      <section className="ad-card">
        <h2>4 · 任务与执行进度</h2>
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
            disabled={!!busy || !session || !jobId || terminalJob(job)}
            onClick={() =>
              void run("请求取消", async () => {
                const value = await call("cancel", { jobId });
                setNotice(
                  "取消请求已返回，不证明目标进程停止；请查询任务状态。",
                );
                persist(jobId, value, true);
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
                invalidate();
                setNotice(
                  "已明确断开旧连接；不证明原副作用回滚。请核对 VS 后重新连接并预览，旧任务仍可从后台查询。",
                );
              })
            }
          >
            已核对 VS，明确断开旧连接以恢复流程
          </button>
        )}
        {unknown && (
          <p className="ad-warning" role="alert">
            结果未知或未确认。执行入口已锁定；请查询原任务并核对 Visual
            Studio，不能将中断视为失败或回滚。若任务身份丢失，需由宿主恢复记录，不可通过重新提交试探。
          </p>
        )}
      </section>
      <section className="ad-card">
        <div className="ad-actions">
          <h2>5 · 调试快照与调用栈</h2>
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
      </section>
      <div aria-live="polite">
        {busy && <p role="status">{busy}…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="ad-warning" role="alert">
            {error}。不可用不代表操作成功；请核对状态，不自动重试。
          </p>
        )}
      </div>
    </section>
  );
}
