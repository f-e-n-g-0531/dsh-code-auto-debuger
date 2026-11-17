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
    const scoped = await this.dir(owner, true);
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
    let text: string;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size > 20 * 1024 * 1024 ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev
      )
        fail("UNSAFE_STORE", "Job file changed");
      const buffer = Buffer.alloc(opened.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 20 * 1024 * 1024)
        fail("STORE_LIMIT", "Job file too large");
      text = buffer.subarray(0, bytesRead).toString("utf8");
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
    return job;
  }
  async list(owner: Owner): Promise<Job[]> {
    const scoped = await this.dir(owner, true);
    const jobs: Job[] = [];
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
          const job = await this.read(entry.name.slice(0, -5), owner);
          // Listing is metadata-only: fetch evidence explicitly via jobStatus.
          jobs.push({ ...job, steps: [], results: [] });
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
    return jobs;
  }
}
