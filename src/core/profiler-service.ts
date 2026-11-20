import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, object, type Owner } from "../protocol/types.js";

type Trace = {
  owner: Owner;
  file: string;
  root?: string;
  pid?: number;
  allowedProcess?: number;
  firstThreadId?: number;
};
const compareOwner = (a: Owner, b: Owner) =>
  a.sessionId === b.sessionId && a.cwd === b.cwd;
const maxTrace = 1024 ** 3;
const integer = (x: unknown, min: number, max: number) => {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < min || x > max)
    return fail("PROFILER_INPUT", "整数参数超出范围");
  return x;
};
const ms = (x: unknown) => {
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    x < 0 ||
    x > 30 * 24 * 3600_000
  )
    return fail("PROFILER_INPUT", "时间参数无效");
  return x;
};
async function workspaceEtl(cwd: string, value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    /[:\0]/.test(value) ||
    path.isAbsolute(value)
  )
    return fail("PROFILER_PATH", "请输入相对于当前工作区的本地路径");
  const file = await realpath(path.resolve(cwd, value));
  const rel = path.relative(cwd, file);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep))
    return fail("PROFILER_PATH", "不能访问工作区之外的路径");
  const info = await stat(file);
  if (
    !info.isFile() ||
    path.extname(file).toLowerCase() !== ".etl" ||
    info.size === 0 ||
    info.size > maxTrace
  )
    return fail("PROFILER_PATH", "需要不超过 1 GiB 的普通 ETL 文件");
  return file;
}
function resolvePdbDirectory(cwd: string, value: unknown) {
  if (typeof value !== "string" || value.length > 4096)
    return fail("PROFILER_PATH", "请输入有效的本地 PDB 目录");
  const input = value.trim();
  if (!input) return "";
  const driveAbsolute = /^[a-z]:[\\/]/i.test(input);
  const remainder = driveAbsolute ? input.slice(2) : input;
  if (
    /[:\x00-\x1f*?"<>|]/.test(remainder) ||
    (!driveAbsolute && path.win32.isAbsolute(input))
  )
    return fail(
      "PROFILER_PATH",
      "PDB 目录仅支持本地盘符绝对路径或工作区相对路径",
    );
  const directory = path.resolve(cwd, input);
  if (!driveAbsolute) {
    const rel = path.relative(cwd, directory);
    if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep))
      return fail("PROFILER_PATH", "工作区外的 PDB 目录请填写本地绝对路径");
  }
  return directory;
}
const run = (
  exe: string,
  args: string[],
  timeout: number | undefined,
  signal?: AbortSignal,
): Promise<any> =>
  new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { windowsHide: true, timeout, signal, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code =
            err.code === "ENOENT" ? "PROFILER_NOT_BUILT" : "PROFILER_HELPER";
          const detail = stderr.trim().slice(0, 500);
          reject(
            Object.assign(
              new Error(
                err.code === "ENOENT"
                  ? "未找到 Windows 性能采集组件"
                  : detail || "性能组件执行失败或超时",
              ),
              { code },
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            Object.assign(new Error("性能组件返回无效数据"), {
              code: "PROFILER_PROTOCOL",
            }),
          );
        }
      },
    );
  });

function defaults(value: unknown) {
  const a = object(value, ["processFilter", "duration", "pdb"]);
  if (
    typeof a.processFilter !== "string" ||
    a.processFilter.length > 256 ||
    typeof a.pdb !== "string" ||
    a.pdb.length > 4096 ||
    a.pdb.includes("\0")
  )
    return fail("PROFILER_INPUT", "性能分析默认参数无效");
  return {
    processFilter: a.processFilter,
    duration: integer(a.duration, 5, 15),
    pdb: a.pdb,
  };
}

export class ProfilerService {
  private readonly traces = new Map<string, Trace>();
  private busy?: Promise<unknown>;
  private disposed = false;
  constructor(
    private readonly executable?: string,
    private readonly defaultsFile?: string,
  ) {}
  private store() {
    if (!this.defaultsFile) return fail("PROFILER_SETTINGS", "录制存储未配置");
    return path.join(path.dirname(this.defaultsFile), "profiler-recordings");
  }
  private manifest(owner: Owner) {
    return path.join(
      this.store(),
      createHash("sha256")
        .update(JSON.stringify([owner.sessionId, owner.cwd]))
        .digest("hex") + ".json",
    );
  }
  private async restore(owner: Owner) {
    if ([...this.traces.values()].some((t) => compareOwner(t.owner, owner)))
      return;
    let record;
    try {
      record = JSON.parse(await readFile(this.manifest(owner), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (
      record?.version !== 1 ||
      !record.owner ||
      !compareOwner(record.owner, owner) ||
      typeof record.id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.id)
    )
      return fail("PROFILER_TRACE", "持久化录制索引无效");
    let trace: Trace;
    if (record.kind === "capture") {
      const root = path.join(this.store(), record.id);
      const file = path.join(root, "recording.etl");
      const size = await lstat(file);
      if (
        !(await lstat(root)).isDirectory() ||
        !size.isFile() ||
        size.size <= 0 ||
        size.size > maxTrace
      )
        return fail("PROFILER_TRACE", "录制文件已不可用");
      trace = {
        owner,
        root,
        file,
        pid: integer(record.pid, 1, 0x7fffffff),
        firstThreadId:
          record.firstThreadId === undefined
            ? undefined
            : integer(record.firstThreadId, 1, 0x7fffffff),
      };
    } else if (record.kind === "import") {
      if (
        typeof record.relative !== "string" ||
        !record.relative ||
        path.isAbsolute(record.relative)
      )
        return fail("PROFILER_TRACE", "导入记录路径无效");
      trace = { owner, file: path.resolve(owner.cwd, record.relative) };
    } else return fail("PROFILER_TRACE", "持久化录制类型无效");
    this.traces.set(record.id, trace);
  }
  private async persist(id: string, trace: Trace) {
    const file = this.manifest(trace.owner);
    const record = {
      version: 1,
      id,
      owner: trace.owner,
      ...(trace.root
        ? {
            kind: "capture",
            pid: trace.pid,
            firstThreadId: trace.firstThreadId,
          }
        : {
            kind: "import",
            relative: path.relative(trace.owner.cwd, trace.file),
          }),
    };
    await this.writeJson(file, record);
  }
  private async writeJson(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  private async settings(endpoint: string, payload: unknown) {
    const file = this.defaultsFile;
    if (!file) return fail("PROFILER_SETTINGS", "全局参数存储未配置");
    if (endpoint === "getDefaults") {
      object(payload, []);
      try {
        return defaults(JSON.parse(await readFile(file, "utf8")));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return { processFilter: "", duration: 7, pdb: "" };
        throw e;
      }
    }
    const settings = defaults(payload);
    await this.writeJson(file, settings);
    return settings;
  }
  private get exe() {
    return (
      this.executable ??
      fileURLToPath(
        new URL("./profiler/win-x64/dsh-profiler.exe", import.meta.url),
      )
    );
  }

  async dispose() {
    this.disposed = true;
    await this.busy?.catch(() => {});
    this.traces.clear();
  }
  private async remove(trace: Trace) {
    if (trace.root) await rm(trace.root, { recursive: true, force: true });
  }
  private find(id: unknown, owner: Owner) {
    const trace = typeof id === "string" && this.traces.get(id);
    if (!trace || !compareOwner(trace.owner, owner))
      return fail("PROFILER_TRACE", "此会话没有该采集记录，请重新导入");
    return trace;
  }
  async invoke(
    endpoint: string,
    payload: unknown,
    owner: Owner,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (process.platform !== "win32")
      return fail("PROFILER_PLATFORM", "性能分析仅支持 Windows");
    if (this.disposed || this.busy)
      return fail("PROFILER_BUSY", "正在处理另一项性能任务，请等待完成");
    const work = this.perform(endpoint, payload, owner, signal);
    this.busy = work;
    try {
      return await work;
    } finally {
      if (this.busy === work) this.busy = undefined;
    }
  }
  private async perform(
    endpoint: string,
    payload: unknown,
    owner: Owner,
    signal?: AbortSignal,
  ) {
    if (
      [
        "current",
        "import",
        "record",
        "close",
        "inspect",
        "frames",
        "analyze",
      ].includes(endpoint)
    )
      await this.restore(owner);
    switch (endpoint) {
      case "getDefaults":
      case "saveDefaults":
        return this.settings(endpoint, payload);
      case "processes": {
        object(payload, []);
        return run(this.exe, ["processes"], 15_000, signal);
      }
      case "current": {
        object(payload, []);
        for (const [traceId, trace] of this.traces)
          if (compareOwner(trace.owner, owner))
            return { traceId, pid: trace.pid };
        return {};
      }
      case "import":
      case "record": {
        // Prevent unbounded trace retention. Imported files are never removed.
        const prior = [...this.traces.entries()].find(([, trace]) =>
          compareOwner(trace.owner, owner),
        );
        const a = object(
          payload,
          endpoint === "import"
            ? ["etlPath"]
            : ["pid", "durationSeconds", "startTicks", "replaceTraceId"],
        );
        const replacing =
          endpoint === "record" && a.replaceTraceId !== undefined;
        if (replacing ? !prior || a.replaceTraceId !== prior[0] : !!prior)
          return fail(
            "PROFILER_TRACE",
            "本会话的记录已变化，请恢复当前记录后再操作。",
          );
        await mkdir(this.store(), { recursive: true });
        const manifests = await readdir(this.store(), { withFileTypes: true });
        if (
          !replacing &&
          manifests.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry.name))
            .length >= 32
        )
          return fail(
            "PROFILER_LIMIT",
            "请先关闭不用的采集记录，再打开新的记录",
          );
        const traceId = randomUUID();
        let trace: Trace;
        if (endpoint === "import") {
          trace = {
            owner,
            file: await workspaceEtl(owner.cwd, a.etlPath),
          };
        } else {
          if (
            typeof a.startTicks !== "string" ||
            !/^[1-9][0-9]{0,17}$/.test(a.startTicks)
          )
            return fail("PROFILER_INPUT", "请从运行中的进程列表重新选择目标。");
          const pid = integer(a.pid, 1, 0x7fffffff);
          const duration = integer(a.durationSeconds, 5, 15);
          const root = path.join(this.store(), traceId);
          await mkdir(root);
          trace = { owner, root, file: path.join(root, "recording.etl"), pid };
          try {
            // Browser navigation does not cancel native ETW; the recorder stops its own sessions.
            signal?.throwIfAborted();
            const captured = await run(
              this.exe,
              [
                "record",
                String(pid),
                String(duration),
                trace.file,
                a.startTicks,
              ],
              undefined,
            );
            if (
              Number.isSafeInteger(captured?.firstThreadId) &&
              captured.firstThreadId > 0
            )
              trace.firstThreadId = captured.firstThreadId;
            const info = await stat(trace.file);
            if (!info.isFile() || info.size === 0 || info.size > maxTrace)
              fail("PROFILER_TRACE", "采集文件为空或超过大小上限");
          } catch (error) {
            await this.remove(trace);
            throw error;
          }
        }
        try {
          await this.persist(traceId, trace);
        } catch (error) {
          await this.remove(trace).catch(() => {});
          throw error;
        }
        this.traces.set(traceId, trace);
        if (prior) {
          this.traces.delete(prior[0]);
          await this.remove(prior[1]).catch(() => {});
        }
        return { traceId, pid: trace.pid };
      }
      case "close": {
        const a = object(payload, ["traceId"]);
        const trace = this.find(a.traceId, owner);
        await rm(this.manifest(owner));
        this.traces.delete(a.traceId);
        await this.remove(trace);
        return {};
      }
      case "inspect":
      case "frames":
      case "analyze": {
        const a = object(payload, [
          "traceId",
          ...(endpoint === "inspect" ? [] : ["processIndex"]),
          ...(endpoint === "analyze" ? ["pdbDir", "startMs", "endMs"] : []),
        ]);
        const trace = this.find(a.traceId, owner);
        const file = trace.root
          ? trace.file
          : await workspaceEtl(owner.cwd, path.relative(owner.cwd, trace.file));
        const args = [endpoint, file];
        if (endpoint !== "inspect") {
          const index = integer(a.processIndex, 0, 0x7fffffff);
          if (trace.pid !== undefined && index !== trace.allowedProcess)
            return fail(
              "PROFILER_TRACE",
              "仅可分析录制时选中的进程，请先读取 ETL 进程列表",
            );
          args.push(String(index));
        }
        if (endpoint === "analyze") {
          const begin = ms(a.startMs),
            end = ms(a.endMs);
          if (begin >= end)
            return fail("PROFILER_INPUT", "结束时间必须晚于开始时间");
          const pdb = resolvePdbDirectory(owner.cwd, a.pdbDir);
          args.push(pdb, String(begin), String(end));
        }
        const result = await run(this.exe, args, 180_000, signal);
        if (endpoint === "inspect" && trace.pid !== undefined) {
          const rows = result.processes.filter(
            (p: { pid: number }) => p.pid === trace.pid,
          );
          trace.allowedProcess = rows.length === 1 ? rows[0].index : undefined;
          if (trace.allowedProcess === undefined)
            return fail("PROFILER_TRACE", "ETL 未唯一识别录制时选中的进程");
          result.processes = rows;
        }
        if (
          endpoint === "analyze" &&
          trace.firstThreadId &&
          !result.mainThreadId
        )
          result.mainThreadId = trace.firstThreadId;
        return result;
      }
      default:
        return fail("PROFILER_INPUT", "未知性能分析操作");
    }
  }
}
