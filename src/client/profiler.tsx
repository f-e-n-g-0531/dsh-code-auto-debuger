import React, { useEffect, useRef, useState } from "react";
import { RpcError, errorText, type Connection, type Data } from "./protocol.js";
import { styles } from "./styles.js";

type RunningProcess = { pid: number; name: string; startTicks: string };
const processKey = (p: RunningProcess) => p.pid + ":" + p.startTicks;
const eligibleName = (name: string) => name.toLowerCase().replace(/\.exe$/, "");
function matchesProcess(p: RunningProcess, query: string) {
  if (!query) return true;
  if (/^\d+$/.test(query) && String(p.pid).includes(query)) return true;
  const term = eligibleName(query);
  if (!term) return false;
  let index = 0;
  for (const char of eligibleName(p.name)) {
    if (char === term[index] && ++index === term.length) return true;
  }
  return false;
}
type Proc = {
  index: number;
  pid: number;
  name: string;
  startMs: number;
  endMs: number;
};
type Stream = { swapChain: string; presents: number[] };
type Row = { name: string; inclusive: number; self: number };
type Thread = {
  tid: number;
  samples: number;
  functions: Row[];
  stacks?: { frames: string[]; samples: number }[];
};
type Report = {
  samples: number;
  stackSamples: number;
  warnings: string[];
  intervalMs: number | null;
  matchedPdbs?: number;
  matchedSymbolModules?: string[];
  unmatchedSymbolModules?: string[];
  threads: Thread[];
  mainThreadId?: number | null;
};
const round = (n: number) => n.toFixed(2);
const intervals = (stream?: Stream) =>
  stream
    ? stream.presents.slice(1).map((endMs, i) => ({
        startMs: stream.presents[i],
        endMs,
        i,
      }))
    : [];
const slowest = (stream?: Stream) =>
  intervals(stream).reduce<
    | {
        startMs: number;
        endMs: number;
        i: number;
      }
    | undefined
  >(
    (best, range) =>
      !best || range.endMs - range.startMs > best.endMs - best.startMs
        ? range
        : best,
    undefined,
  );

export function ProfilerPanel({
  connection,
  sessionId,
}: {
  connection: Connection;
  sessionId?: string;
}) {
  const [trace, setTrace] = useState("");
  const [running, setRunning] = useState<RunningProcess[]>([]);
  const [targetKey, setTargetKey] = useState("");
  const [processFilter, setProcessFilter] = useState("");
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [targetError, setTargetError] = useState("");
  const query = processFilter.trim().toLowerCase();
  const filteredTargets = running.filter((p) => matchesProcess(p, query));
  const target = filteredTargets.find((p) => processKey(p) === targetKey);
  const [duration, setDuration] = useState("7");
  const [etl, setEtl] = useState("");
  const [pdb, setPdb] = useState("");
  const [defaultsNotice, setDefaultsNotice] = useState("");
  const defaultsEdited = useRef(false);
  const [initializing, setInitializing] = useState(!!sessionId);
  const [processes, setProcesses] = useState<Proc[]>([]);
  const [processIndex, setProcessIndex] = useState("");
  const [streams, setStreams] = useState<Stream[]>([]);
  const [streamIndex, setStreamIndex] = useState("0");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [report, setReport] = useState<Report>();
  const [thread, setThread] = useState("0");
  const [functionSort, setFunctionSort] = useState<"inclusive" | "self">(
    "inclusive",
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [timelineNote, setTimelineNote] = useState("");
  const [rangeLabel, setRangeLabel] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);
  async function rpc<T>(
    action: string,
    args: Data,
    signal?: AbortSignal,
  ): Promise<T> {
    const r = (await connection.rpc.call(
      "/auto-debug-profiler-rpc",
      action,
      { sessionId, ...args },
      signal,
    )) as Data;
    if (!r?.ok)
      throw new RpcError(
        r?.error?.code ?? "PROFILER_ERROR",
        r?.error?.message ?? "后台没有返回结果",
      );
    return r.value;
  }
  const targetRequest = useRef<AbortController | undefined>(undefined);
  async function refreshTargets() {
    if (!sessionId) return;
    targetRequest.current?.abort();
    const controller = new AbortController();
    targetRequest.current = controller;
    setLoadingTargets(true);
    setTargetError("");
    try {
      const result = await rpc<{ processes: RunningProcess[] }>(
        "processes",
        {},
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setRunning(result.processes);
      setTargetKey((key) =>
        result.processes.some((p) => processKey(p) === key) ? key : "",
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        const message = errorText(e);
        setTargetError(
          /\bHTTP 405\b/i.test(message)
            ? "无法加载进程列表：当前 DSH 后端未提供性能分析接口（HTTP 405）。请从托盘完全退出 DSH，再重新打开。"
            : "无法加载进程列表：" + message,
        );
      }
    } finally {
      if (!controller.signal.aborted) setLoadingTargets(false);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    if (sessionId)
      void (async () => {
        let restoredPdb = "";
        try {
          const state = await rpc<{
            processFilter: string;
            duration: number;
            pdb: string;
          }>("getDefaults", {}, c.signal);
          if (!c.signal.aborted && !defaultsEdited.current) {
            restoredPdb = state.pdb;
            setProcessFilter(state.processFilter);
            setDuration(String(state.duration));
            setPdb(state.pdb);
          }
        } catch (e) {
          if (!c.signal.aborted)
            setDefaultsNotice("无法读取全局参数：" + errorText(e));
        }
        try {
          c.signal.throwIfAborted();
          const previous = await rpc<{ traceId?: string; pid?: number }>(
            "current",
            {},
            c.signal,
          );
          c.signal.throwIfAborted();
          if (previous.traceId) {
            setTrace(previous.traceId);
            await inspect(
              previous.traceId,
              previous.pid,
              c.signal,
              restoredPdb,
            );
          }
        } catch (e) {
          if (!c.signal.aborted) setError("恢复上次记录失败：" + errorText(e));
        } finally {
          if (!c.signal.aborted) {
            setInitializing(false);
            setBusy("");
            void refreshTargets();
          }
        }
      })();
    return () => {
      c.abort();
      targetRequest.current?.abort();
    };
  }, [connection, sessionId]);
  async function work(
    label: string,
    fn: (signal: AbortSignal) => Promise<void>,
  ) {
    if (!sessionId || lock.current) return;
    const c = new AbortController();
    abort.current = c;
    lock.current = true;
    setBusy(label);
    setError("");
    try {
      await fn(c.signal);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
    }
  }
  const clear = () => {
    setProcesses([]);
    setProcessIndex("");
    setStreams([]);
    setStart("");
    setEnd("");
    setReport(undefined);
    setTimelineNote("");
    setRangeLabel("");
  };
  async function selectProcess(
    traceId: string,
    proc: Proc,
    signal: AbortSignal,
    symbolDirectory = pdb,
  ) {
    setProcessIndex(String(proc.index));
    setReport(undefined);
    setStreams([]);
    setStreamIndex("0");
    setStart(String(proc.startMs));
    setEnd(String(proc.endMs));
    setTimelineNote("");
    setBusy("正在读取 Present 事件…");
    let primary: Stream | undefined;
    try {
      const result = await rpc<{ streams: Stream[]; warnings?: string[] }>(
        "frames",
        { traceId, processIndex: proc.index },
        signal,
      );
      signal.throwIfAborted();
      if (!alive.current) return;
      setStreams(result.streams);
      primary = result.streams[0]; // Analyzer orders by Present count.
      setTimelineNote(result.warnings?.join("；") ?? "");
    } catch (e) {
      signal.throwIfAborted();
      if (!alive.current) return;
      setTimelineNote(
        "未能读取 Present 时间线，改用整个进程区间。" + errorText(e),
      );
    }
    const range = slowest(primary);
    await analyze(
      traceId,
      proc.index,
      range ?? proc,
      range ? "主要交换链最慢 Present 间隔" : "整个进程录制区间",
      signal,
      symbolDirectory,
    );
  }
  async function analyze(
    traceId: string,
    index: number,
    range: { startMs: number; endMs: number },
    label: string,
    signal: AbortSignal,
    symbolDirectory = pdb,
  ) {
    signal.throwIfAborted();
    if (!alive.current) return;
    const { startMs, endMs } = range;
    setStart(String(startMs));
    setEnd(String(endMs));
    setReport(undefined);
    setRangeLabel(label);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    )
      throw new Error("没有可分析的时间范围。");
    setBusy("正在分析 CPU 样本…");
    const r = await rpc<Report>(
      "analyze",
      {
        traceId,
        processIndex: index,
        pdbDir: symbolDirectory.trim(),
        startMs,
        endMs,
      },
      signal,
    );
    if (alive.current && !signal.aborted) {
      setThread(
        String(
          Math.max(
            0,
            r.threads.findIndex((t) => t.tid === r.mainThreadId),
          ),
        ),
      );
      setReport(r);
    }
  }
  function analyzeInterval(range: { startMs: number; endMs: number }) {
    void work("正在分析 CPU 样本…", (s) =>
      analyze(trace, Number(processIndex), range, "所选 Present 间隔", s),
    );
  }
  async function inspect(
    traceId: string,
    selectedPid: number | undefined,
    signal: AbortSignal,
    symbolDirectory = pdb,
  ) {
    const r = await rpc<{ processes: Proc[] }>("inspect", { traceId }, signal);
    if (!alive.current) return;
    setProcesses(r.processes);
    const matches =
      selectedPid === undefined
        ? r.processes
        : r.processes.filter((x) => x.pid === selectedPid);
    if (matches.length === 1)
      await selectProcess(traceId, matches[0], signal, symbolDirectory);
  }
  async function open(kind: "record" | "import", signal: AbortSignal) {
    if (kind === "record" ? !target : !!trace) return;
    const r = await rpc<{ traceId: string; pid?: number }>(
      kind,
      kind === "record"
        ? {
            pid: target?.pid,
            startTicks: target?.startTicks,
            durationSeconds: Number(duration),
            ...(trace ? { replaceTraceId: trace } : {}),
          }
        : { etlPath: etl },
      signal,
    );
    if (!alive.current) return;
    clear();
    setTrace(r.traceId);
    if (kind === "record") {
      try {
        await rpc(
          "saveDefaults",
          { processFilter, duration: Number(duration), pdb: pdb.trim() },
          signal,
        );
      } catch (e) {
        if (alive.current && !signal.aborted)
          setDefaultsNotice("录制已完成，但无法保存上次参数：" + errorText(e));
      }
    }
    signal.throwIfAborted();
    await inspect(
      r.traceId,
      kind === "record" ? (r.pid ?? target?.pid) : undefined,
      signal,
    );
  }
  const current = streams[Number(streamIndex)];
  const frames = intervals(current);
  const peak = Math.max(1, ...frames.map((f) => f.endMs - f.startMs));
  // Max in each bin keeps the slowest interval visible even on a long trace.
  const bucket = Math.max(1, Math.ceil(frames.length / 120));
  const displayed = frames.reduce<typeof frames>((out, frame, i) => {
    const index = Math.floor(i / bucket),
      old = out[index];
    if (!old || frame.endMs - frame.startMs > old.endMs - old.startMs)
      out[index] = frame;
    return out;
  }, []);
  const focus = report?.threads[Number(thread)];
  const [showAllFunctions, setShowAllFunctions] = useState(false);
  const topOwn =
    focus?.functions
      .filter((f) => f.self > 0)
      .sort(
        (a, b) =>
          b.self - a.self ||
          b.inclusive - a.inclusive ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 3) ?? [];
  const percent = (n: number) =>
    focus?.samples ? ((100 * n) / focus.samples).toFixed(1) + "%" : "—";
  const weightShort = (n: number) =>
    report?.intervalMs ? round(n * report.intervalMs) + " ms" : n + " 样本";
  const otherSort = functionSort === "inclusive" ? "self" : "inclusive";
  const sortedFunctions =
    focus?.functions
      .slice()
      .sort(
        (a, b) =>
          b[functionSort] - a[functionSort] ||
          b[otherSort] - a[otherSort] ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 40) ?? [];
  const weight = (n: number) =>
    report?.intervalMs
      ? round(n * report.intervalMs) + " ms（" + n + " 样本）"
      : String(n);
  return (
    <section className="ad-root">
      <style>{styles}</style>
      <header>
        <h2>性能分析</h2>
      </header>
      <p>
        直接对 Windows EXE 做 CPU 采样，不附加调试器，不依赖 WPR、WPA 或 Visual
        Studio。
      </p>
      {!sessionId && <p>请先打开一个 DSH 会话。</p>}
      <p role="status">
        {busy || (initializing ? "正在读取上次记录和参数…" : error)}
      </p>
      <fieldset disabled={!sessionId || initializing || !!busy}>
        <legend>采集或导入</legend>
        <p>
          内置采集需要管理员权限。CPU
          数据为系统级采样，录制文件暂存在本机，分析时可筛选目标
          PID。关闭记录会清理插件创建的文件。
        </p>
        <label>
          搜索进程{" "}
          <input
            value={processFilter}
            onChange={(e) => {
              defaultsEdited.current = true;
              setProcessFilter(e.target.value);
            }}
            placeholder="例如 soul.exe"
          />
        </label>{" "}
        <button
          type="button"
          onClick={() => void refreshTargets()}
          disabled={loadingTargets}
        >
          刷新进程
        </button>
        <div style={{ marginBlock: 12 }}>
          {targetError ? (
            <p role="alert">{targetError}</p>
          ) : (
            <p role="status">
              {loadingTargets
                ? "正在读取进程…"
                : filteredTargets.length
                  ? filteredTargets.length + " 个进程"
                  : query
                    ? "没有匹配的进程"
                    : "没有可录制的进程"}
            </p>
          )}
          <label>
            目标进程{" "}
            <select
              size={8}
              style={{ width: "100%" }}
              value={target?.pid ? targetKey : ""}
              onChange={(e) => setTargetKey(e.target.value)}
              disabled={loadingTargets || !!targetError}
            >
              <option value="" disabled>
                请点击下面的进程以选择录制目标
              </option>
              {filteredTargets.map((p) => (
                <option key={processKey(p)} value={processKey(p)}>
                  {p.name} · PID {p.pid}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          录制秒数{" "}
          <input
            type="number"
            min="5"
            max="15"
            value={duration}
            onChange={(e) => {
              defaultsEdited.current = true;
              setDuration(e.target.value);
            }}
          />
        </label>{" "}
        <button
          disabled={!!trace}
          onClick={() =>
            void work("正在恢复…", async (s) => {
              const r = await rpc<{ traceId?: string; pid?: number }>(
                "current",
                {},
                s,
              );
              if (!alive.current) return;
              if (!r.traceId) throw new Error("本会话没有待恢复的记录。");
              clear();
              setTrace(r.traceId);
              await inspect(r.traceId, r.pid, s);
            })
          }
        >
          恢复本会话记录
        </button>{" "}
        <button
          disabled={!target || loadingTargets || !!targetError}
          onClick={() => void work("正在录制…", (s) => open("record", s))}
        >
          {trace ? "重新录制并分析" : "录制并分析"}
        </button>
        {!target &&
          !loadingTargets &&
          !targetError &&
          filteredTargets.length > 0 && (
            <p className="ad-hint">请先选择进程，才能开始录制。</p>
          )}
        {trace && (
          <p className="ad-hint">
            新录制成功后会替换当前记录；录制失败保留当前记录。导入的原始文件不会删除。
          </p>
        )}
        <details>
          <summary>符号、导入与记录管理</summary>
          <p>
            <button
              type="button"
              onClick={() =>
                void work("正在保存全局参数…", async (s) => {
                  setDefaultsNotice("");
                  await rpc(
                    "saveDefaults",
                    {
                      processFilter,
                      duration: Number(duration),
                      pdb: pdb.trim(),
                    },
                    s,
                  );
                  if (alive.current)
                    setDefaultsNotice("已保存为全局默认参数。");
                })
              }
            >
              保存为全局默认
            </button>{" "}
            <span role="status">{defaultsNotice}</span>
          </p>
          <p>
            <label>
              本地 PDB 目录（支持绝对路径，可留空）{" "}
              <input
                value={pdb}
                onChange={(e) => {
                  defaultsEdited.current = true;
                  setPdb(e.target.value);
                  setReport(undefined);
                }}
              />
            </label>
          </p>
          <p>
            <label>
              工作区内 ETL 路径{" "}
              <input value={etl} onChange={(e) => setEtl(e.target.value)} />
            </label>{" "}
            <button
              disabled={!!trace || !etl.trim()}
              onClick={() =>
                void work("正在导入 ETL…", (s) => open("import", s))
              }
            >
              导入
            </button>{" "}
            {trace && (
              <>
                <button
                  onClick={() =>
                    void work("正在关闭…", async (s) => {
                      await rpc("close", { traceId: trace }, s);
                      if (alive.current) {
                        setTrace("");
                        clear();
                      }
                    })
                  }
                >
                  关闭记录
                </button>{" "}
                <button
                  onClick={() =>
                    void work("正在读取 ETL…", (s) => {
                      clear();
                      return inspect(trace, undefined, s);
                    })
                  }
                >
                  重新读取进程
                </button>
              </>
            )}
          </p>
        </details>
      </fieldset>
      {trace && (
        <fieldset disabled={initializing || !!busy}>
          <legend>所选时间范围</legend>
          <label>
            进程{" "}
            <select
              value={processIndex}
              onChange={(e) => {
                const p = processes.find(
                  (p) => String(p.index) === e.target.value,
                );
                if (p)
                  void work("正在读取 Present 事件…", (s) =>
                    selectProcess(trace, p, s),
                  );
              }}
            >
              <option value="" disabled>
                选择进程
              </option>
              {processes.map((p) => (
                <option key={p.index} value={p.index}>
                  {p.name} · PID {p.pid} · {round(p.startMs)}–{round(p.endMs)}{" "}
                  ms
                </option>
              ))}
            </select>
          </label>
          {timelineNote && <p>{timelineNote}</p>}
          {processIndex && (
            <>
              <p>
                {streams.length
                  ? "DXGI Present 间隔，不等同于游戏逻辑帧。每组保留最慢间隔。"
                  : "没有可用的 DXGI Present 流；仍可手选时间范围。"}
              </p>
              {!!streams.length && (
                <>
                  <label>
                    交换链{" "}
                    <select
                      value={streamIndex}
                      onChange={(e) => setStreamIndex(e.target.value)}
                    >
                      {streams.map((v, i) => (
                        <option key={i} value={i}>
                          {v.swapChain} · {v.presents.length} 次
                        </option>
                      ))}
                    </select>
                  </label>
                  <div
                    aria-label="Present 间隔时间线"
                    style={{
                      display: "flex",
                      alignItems: "end",
                      overflowX: "auto",
                      gap: 2,
                      minHeight: 70,
                      marginBlock: 10,
                    }}
                  >
                    {displayed.map((f) => (
                      <button
                        key={f.i}
                        type="button"
                        title={round(f.endMs - f.startMs) + " ms"}
                        aria-label={
                          "间隔 " +
                          (f.i + 1) +
                          "：" +
                          round(f.endMs - f.startMs) +
                          " ms"
                        }
                        style={{
                          height: Math.max(
                            8,
                            ((f.endMs - f.startMs) * 70) / peak,
                          ),
                          minWidth: 5,
                          padding: 0,
                          flex: "1 0 5px",
                        }}
                        aria-pressed={
                          Number(start) === f.startMs && Number(end) === f.endMs
                        }
                        onClick={() => analyzeInterval(f)}
                      />
                    ))}
                  </div>
                  <label>
                    选择任意间隔{" "}
                    <select
                      value=""
                      onChange={(e) => {
                        const f = frames[Number(e.target.value)];
                        if (f) analyzeInterval(f);
                      }}
                    >
                      <option value="" disabled>
                        选择…
                      </option>
                      {frames.map((f) => (
                        <option key={f.i} value={f.i}>
                          {f.i + 1} · {round(f.startMs)} ms ·{" "}
                          {round(f.endMs - f.startMs)} ms
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <p>
                <label>
                  开始 ms{" "}
                  <input
                    type="number"
                    step="any"
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value);
                      setRangeLabel("手选时间范围");
                      setReport(undefined);
                    }}
                  />
                </label>{" "}
                <label>
                  结束 ms{" "}
                  <input
                    type="number"
                    step="any"
                    value={end}
                    onChange={(e) => {
                      setEnd(e.target.value);
                      setRangeLabel("手选时间范围");
                      setReport(undefined);
                    }}
                  />
                </label>
              </p>
              <button
                disabled={!start || !end || Number(end) <= Number(start)}
                onClick={() =>
                  void work("正在分析 CPU 样本…", (s) =>
                    analyze(
                      trace,
                      Number(processIndex),
                      { startMs: Number(start), endMs: Number(end) },
                      rangeLabel || "手选时间范围",
                      s,
                    ),
                  )
                }
              >
                分析此区间
              </button>
            </>
          )}
        </fieldset>
      )}
      {report && (
        <section>
          <h3>CPU 采样热点</h3>
          <p>
            {rangeLabel}（{round(Number(start))}–{round(Number(end))} ms）：
            {report.samples} 个 CPU 样本，其中 {report.stackSamples}{" "}
            个有调用栈。
            {report.intervalMs
              ? "CPU 权重为估算，不是函数单次调用时间。"
              : "采样间隔未知，只显示样本计数。"}
          </p>
          {report.matchedPdbs !== undefined && (
            <details>
              <summary>本地 PDB 匹配：{report.matchedPdbs} 个</summary>
              {!!report.matchedSymbolModules?.length && (
                <p>已匹配：{report.matchedSymbolModules.join("、")}</p>
              )}
              {!!report.unmatchedSymbolModules?.length && (
                <p>未匹配：{report.unmatchedSymbolModules.join("、")}</p>
              )}
            </details>
          )}
          {report.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <p>
            {report.mainThreadId == null
              ? "主线程：无法从本次录制确认"
              : "推定主线程：TID " +
                report.mainThreadId +
                (report.threads.some((t) => t.tid === report.mainThreadId)
                  ? ""
                  : "（不在当前热点列表中）")}
          </p>
          {focus && (
            <>
              <label>
                线程{" "}
                <select
                  value={thread}
                  onChange={(e) => {
                    setThread(e.target.value);
                    setShowAllFunctions(false);
                  }}
                >
                  {report.threads.map((t, i) => (
                    <option key={i} value={i}>
                      {t.tid === report.mainThreadId ? "推定主线程 · " : ""}TID{" "}
                      {t.tid} · {t.samples} 样本
                    </option>
                  ))}
                </select>
              </label>
              <div className="ad-profiler-summary">
                <h4>先看：CPU 实际采到了哪些函数？</h4>
                <p>
                  当前线程：TID {focus.tid} · {weight(focus.samples)}
                  。以下按自身采样降序。
                </p>
                {topOwn.length ? (
                  <ul>
                    {topOwn.map((f, i) => (
                      <li key={i}>
                        <code>{f.name}</code>
                        <strong>
                          {weightShort(f.self)} · {percent(f.self)}
                        </strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>没有可展示的自身采样热点。</p>
                )}
              </div>
              <h4>函数明细</h4>
              <p className="ad-hint">
                自身：采样指令落在该函数。含子调用：只要该函数出现在栈里就计入；同一份样本会出现在多行，不能相加。「—」表示没有自身样本，不是函数不耗时。
              </p>
              <label>
                函数耗时排序{" "}
                <select
                  value={functionSort}
                  onChange={(e) =>
                    setFunctionSort(
                      e.target.value === "self" ? "self" : "inclusive",
                    )
                  }
                >
                  <option value="inclusive">含子调用 CPU 时间：从高到低</option>
                  <option value="self">自身 CPU 时间：从高到低</option>
                </select>
              </label>
              <div className="ad-profiler-table-wrap">
                <table className="ad-profiler-table">
                  <thead>
                    <tr>
                      <th>函数 / 模块偏移</th>
                      <th>自身 CPU</th>
                      <th>含子调用 CPU</th>
                      <th>占该线程样本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedFunctions
                      .slice(0, showAllFunctions ? 40 : 8)
                      .map((f, i) => (
                        <tr key={i}>
                          <td>
                            <code>{f.name}</code>
                          </td>
                          <td>{f.self ? weightShort(f.self) : "—"}</td>
                          <td>{weightShort(f.inclusive)}</td>
                          <td>{percent(f[functionSort])}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {sortedFunctions.length > 8 && (
                <button
                  type="button"
                  aria-expanded={showAllFunctions}
                  onClick={() => setShowAllFunctions((v) => !v)}
                >
                  {showAllFunctions
                    ? "收起函数明细"
                    : "展开全部 " + sortedFunctions.length + " 个函数"}
                </button>
              )}
              {!!focus.stacks?.length && (
                <details className="ad-profiler-stacks">
                  <summary>代表调用链（{focus.stacks.length} 条）</summary>
                  <p className="ad-hint">
                    每条从调用方到被调用方。权重是整条链的采样估算，不是每个函数的耗时。
                  </p>
                  {focus.stacks.map((s, i) => (
                    <details key={i}>
                      <summary>
                        路径 {i + 1} · {weight(s.samples)} · 采样点：
                        <code>{s.frames.at(-1) ?? "未知"}</code>
                      </summary>
                      <ol>
                        {s.frames.map((f, j) => (
                          <li key={j}>{f}</li>
                        ))}
                      </ol>
                    </details>
                  ))}
                </details>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
