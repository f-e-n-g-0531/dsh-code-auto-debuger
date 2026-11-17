import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyPublicPackage } from "../scripts/ci/npm-registry.mjs";
const pkg = { name: "@test/plugin", version: "1.2.3", license: "MIT" },
  bytes = Buffer.from("verified package");
const meta = {
  ...pkg,
  dist: {
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    tarball: "https://registry.npmjs.org/test.tgz",
  },
};
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
test("waits for exact public metadata and downloads identical bytes with no-cache, then verifies latest", async () => {
  let reads = 0,
    sleeps = 0,
    downloaded = 0;
  await verifyPublicPackage(pkg, bytes, {
    attempts: 3,
    delayMs: 0,
    sleep: async () => sleeps++,
    log: () => {},
    fetchImpl: async (url, options) => {
      assert.equal(options.headers["Cache-Control"], "no-cache");
      if (url.includes("/-/package/")) return json({ latest: pkg.version });
      if (url.includes("test.tgz")) {
        downloaded++;
        return new Response(bytes);
      }
      reads++;
      return reads === 1 ? new Response("", { status: 404 }) : json(meta);
    },
  });
  assert.equal(sleeps, 1);
  assert.equal(downloaded, 1);
});
test("accepted upload never becomes success when public version remains absent", async () => {
  await assert.rejects(
    verifyPublicPackage(pkg, bytes, {
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
      log: () => {},
      fetchImpl: async () => new Response("", { status: 404 }),
    }),
    /not verified/,
  );
});
test("wrong public metadata, unsafe tarball, changed bytes and wrong latest fail closed", async () => {
  for (const kind of ["integrity", "url", "bytes", "latest"]) {
    await assert.rejects(
      verifyPublicPackage(pkg, bytes, {
        attempts: 1,
        delayMs: 0,
        log: () => {},
        fetchImpl: async (url) => {
          if (url.includes("/-/package/"))
            return json({ latest: "0.0.0-stage" });
          if (url.includes("test.tgz"))
            return new Response(
              kind === "bytes" ? Buffer.from("other") : bytes,
            );
          return json(
            kind === "integrity"
              ? { ...meta, dist: { ...meta.dist, integrity: "bad" } }
              : kind === "url"
                ? {
                    ...meta,
                    dist: { ...meta.dist, tarball: "https://evil.invalid/a" },
                  }
                : meta,
          );
        },
      }),
    );
  }
});
test("metadata transport outage is retried but publication is never invoked", async () => {
  let calls = 0;
  await verifyPublicPackage(pkg, bytes, {
    attempts: 2,
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    fetchImpl: async (url) => {
      if (url.includes("/-/package/")) return json({ latest: pkg.version });
      if (url.includes("test.tgz")) return new Response(bytes);
      if (calls++ === 0) throw new TypeError("offline");
      return json(meta);
    },
  });
  assert.equal(calls, 2);
});
