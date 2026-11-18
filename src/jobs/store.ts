import {
  mkdir,
  writeFile,
  rename,
  lstat,
  realpath,
  opendir,
  open,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fail, type Owner } from "../protocol/types.js";
export interface Job {
  jobId: string;
  owner: Owner;
  target: any;
  status: string;
  steps: any[];
  results: any[];
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
  externalState: string;
  persistence?: {
    status: "pending" | "saved" | "failed";
    error?: { code: string; message: string };
  };
  outcome?: string;
  requestId?: string;
  previewId?: string;
}
export async function projectedPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...suffix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      try {
        if ((await lstat(current)).isSymbolicLink())
          fail("UNSAFE_STORE", "Dangling store symlink");
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
      }
      const parent = path.dirname(current);
      if (parent === current) throw e;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
export class JobStore {
  private canonical?: string;
  private summaries = new Map<
    string,
    { revision: string; job: Job; bytes: number }
  >();
  private summaryBytes = 0;
  private rememberSummary(file: string, revision: string, job: Job) {
    const previous = this.summaries.get(file);
    this.summaries.delete(file);
    this.summaryBytes -= previous?.bytes ?? 0;
    const summary = { ...job, steps: [], results: [] };
    const bytes = Buffer.byteLength(JSON.stringify(summary));
    if (bytes <= 512 * 1024) {
      while (
        this.summaries.size >= 512 ||
        this.summaryBytes + bytes > 8 * 1024 * 1024
      ) {
        const first = this.summaries.keys().next().value!;
        this.summaryBytes -= this.summaries.get(first)!.bytes;
        this.summaries.delete(first);
      }
      this.summaries.set(file, { revision, job: summary, bytes });
      this.summaryBytes += bytes;
    }
    return structuredClone(summary);
  }
  constructor(private directory: string) {}
  private async dir(owner: Owner, recovery = false) {
    const dir = await projectedPath(this.directory),
      workspace = recovery ? undefined : await realpath(owner.cwd);
    const rel = workspace === undefined ? ".." : path.relative(workspace, dir);
    if (
      !rel ||
      (rel !== ".." &&
        !rel.startsWith(".." + path.sep) &&
        !path.isAbsolute(rel))
    )
      fail("UNSAFE_STORE", "Job store must be outside target workspace");
    if (this.canonical && dir !== this.canonical)
      fail("UNSAFE_STORE", "Store location changed");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (
      (await lstat(this.directory)).isSymbolicLink() ||
      (await realpath(this.directory)) !== dir
    )
      fail("UNSAFE_STORE", "Store path changed");
    this.canonical = dir;
    const scoped = path.join(
      dir,
      createHash("sha256").update(owner.sessionId).digest("hex"),
    );
    await mkdir(scoped, { recursive: true, mode: 0o700 });
    if (
      (await lstat(scoped)).isSymbolicLink() ||
      (await realpath(scoped)) !== scoped
    )
      fail("UNSAFE_STORE", "Invalid session store");
    return scoped;
  }
  async save(job: Job) {
    this.id(job.jobId);
    const dir = await this.dir(job.owner),
      file = path.join(dir, job.jobId + ".json"),
      tmp = path.join(dir, randomUUID() + ".tmp");
    const text = JSON.stringify(job);
    if (Buffer.byteLength(text) > 20 * 1024 * 1024)
      fail("STORE_LIMIT", "Job exceeds storage budget");
    try {
      await writeFile(tmp, text, { flag: "wx", mode: 0o600 });
      await this.dir(job.owner);
      await rename(tmp, file);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  private id(id: string) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
      fail("INVALID_JOB", "Invalid job id");
  }
  async read(id: string, owner: Owner): Promise<Job> {
    this.id(id);
    return this.readRecord(id, owner, await this.dir(owner, true));
  }
  private async readRecord(
    id: string,
    owner: Owner,
    scoped: string,
    summaryOnly = false,
  ): Promise<Job> {
    this.id(id);
    let file = path.join(scoped, id + ".json");
    let stat;
    try {
      stat = await lstat(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // Legacy 0.1.0 recovery by explicit UUID only: never enumerate foreign root records.
      file = path.join(path.dirname(scoped), id + ".json");
      stat = await lstat(file);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
      fail("UNSAFE_STORE", "Invalid job file");
    const handle = await open(file, "r");
    let text: string, revision: string;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size > 20 * 1024 * 1024 ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev
      )
        fail("UNSAFE_STORE", "Job file changed");
      revision = JSON.stringify([
        opened.dev,
        opened.ino,
        opened.size,
        opened.mtimeMs,
        opened.ctimeMs,
        opened.birthtimeMs,
      ]);
      const cached =
        summaryOnly && opened.ino !== 0 ? this.summaries.get(file) : undefined;
      if (cached && revision === cached.revision) {
        if (cached.job.owner.sessionId !== owner.sessionId)
          fail("FOREIGN_JOB", "Job belongs to another owner");
        this.summaries.delete(file);
        this.summaries.set(file, cached);
        return structuredClone(cached.job);
      }
      text = await this.readBody(handle, opened.size);
      const after = await handle.stat();
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        fail("STORE_CHANGED", "Job file changed while reading");
    } finally {
      await handle.close();
    }
    const job = JSON.parse(text!) as Job;
    if (
      !job ||
      typeof job !== "object" ||
      job.jobId !== id ||
      !job.owner ||
      typeof job.owner.sessionId !== "string" ||
      typeof job.owner.cwd !== "string" ||
      !path.isAbsolute(job.owner.cwd) ||
      typeof job.status !== "string" ||
      ![
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
        "interrupted",
        "persistence_failed",
      ].includes(job.status) ||
      (job.createdAt !== undefined && typeof job.createdAt !== "string") ||
      (job.updatedAt !== undefined && typeof job.updatedAt !== "string") ||
      (job.requestId !== undefined &&
        (typeof job.requestId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(job.requestId))) ||
      !Array.isArray(job.steps) ||
      job.steps.length > 100 ||
      !Array.isArray(job.results) ||
      job.results.length > 100
    )
      fail("UNSAFE_STORE", "Malformed job record");
    if (job.owner.sessionId !== owner.sessionId)
      fail("FOREIGN_JOB", "Job belongs to another owner");
    if (["running", "queued"].includes(job.status)) {
      job.status = "interrupted";
      job.externalState = "unknown";
      job.error = {
        code: "INTERRUPTED",
        message: "Host restarted; inspect VS state, never replay mutations",
      };
    }
    return summaryOnly ? this.rememberSummary(file, revision, job) : job;
  }
  private async readBody(handle: FileHandle, size: number) {
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 20 * 1024 * 1024) fail("STORE_LIMIT", "Job file too large");
    return buffer.subarray(0, offset).toString("utf8");
  }
  async list(owner: Owner): Promise<Job[]> {
    const scoped = await this.dir(owner, true);
    const jobs = new Map<string, Job>();
    let scanned = 0,
      bytes = 0;
    // Legacy flat records remain read-only recoverable; the same global scan limits apply.
    for (const location of [scoped, path.dirname(scoped)]) {
      const directory = await opendir(location);
      for await (const entry of directory) {
        if (++scanned > 4096)
          fail("STORE_LIMIT", "Too many stored jobs; narrow store offline");
        if (
          !/^[a-f0-9-]{36}\.json$/.test(entry.name) ||
          !entry.isFile() ||
          entry.isSymbolicLink()
        )
          continue;
        try {
          bytes += (await lstat(path.join(location, entry.name))).size;
          if (bytes > 64 * 1024 * 1024)
            fail("STORE_LIMIT", "Job listing exceeds scan byte budget");
          // Legacy recovery remains scoped-first. Details bypass this cache.
          const job = await this.readRecord(
            entry.name.slice(0, -5),
            owner,
            scoped,
            true,
          );
          if (!jobs.has(job.jobId)) jobs.set(job.jobId, job);
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (
            code === "UNSAFE_STORE" ||
            code === "FOREIGN_JOB" ||
            code === "ENOENT" ||
            e instanceof SyntaxError
          )
            continue;
          throw e;
        }
      }
    }
    return [...jobs.values()];
  }
}
