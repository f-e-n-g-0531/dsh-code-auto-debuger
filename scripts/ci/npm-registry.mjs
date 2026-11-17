import { createHash } from "node:crypto";
const integrity = (bytes) =>
  "sha512-" + createHash("sha512").update(bytes).digest("base64");
export async function verifyPublicPackage(
  pkg,
  bytes,
  {
    fetchImpl = fetch,
    attempts = 60,
    delayMs = 10000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    log = console.log,
  } = {},
) {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 60 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > 10000
  )
    throw Error("Invalid registry verification budget");
  const endpoint =
    "https://registry.npmjs.org/" +
    encodeURIComponent(pkg.name) +
    "/" +
    pkg.version;
  for (let i = 0; i < attempts; i++) {
    let response;
    try {
      response = await fetchImpl(endpoint + "?verify=" + now(), {
        signal: AbortSignal.timeout(15000),
        redirect: "error",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
    } catch (error) {
      if (i + 1 === attempts) throw error;
      await sleep(delayMs);
      continue;
    }
    if (response.ok) {
      const meta = await response.json();
      if (
        meta.name !== pkg.name ||
        meta.version !== pkg.version ||
        meta.license !== pkg.license ||
        meta.dist?.integrity !== integrity(bytes)
      )
        throw Error(
          "Public npm metadata/integrity differs from verified artifact",
        );
      const url = new URL(meta.dist.tarball);
      if (
        url.origin !== "https://registry.npmjs.org" ||
        url.username ||
        url.password
      )
        throw Error("Invalid public npm artifact URL");
      let tar;
      try {
        tar = await fetchImpl(url.href, {
          signal: AbortSignal.timeout(30000),
          redirect: "error",
          headers: { "Cache-Control": "no-cache" },
        });
      } catch (error) {
        if (i + 1 === attempts) throw error;
        await sleep(delayMs);
        continue;
      }
      if (tar.ok) {
        if (!tar.body) throw Error("Missing public npm artifact body");
        const reader = tar.body.getReader(),
          chunks = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > bytes.length) {
              await reader.cancel();
              throw Error("Public npm artifact exceeds expected size");
            }
            chunks.push(Buffer.from(part.value));
          }
        } finally {
          reader.releaseLock();
        }
        const actual = Buffer.concat(chunks);
        if (!actual.equals(bytes))
          throw Error("Public npm artifact bytes differ from verified archive");
        const tags = await fetchImpl(
          "https://registry.npmjs.org/-/package/" +
            encodeURIComponent(pkg.name) +
            "/dist-tags?verify=" +
            now(),
          {
            signal: AbortSignal.timeout(15000),
            redirect: "error",
            headers: { "Cache-Control": "no-cache" },
          },
        );
        if (!tags.ok) throw Error("Cannot verify public npm dist-tags");
        const value = await tags.json();
        if (value.latest !== pkg.version)
          throw Error("Public npm latest does not select verified version");
        log(
          "Verified public npm bytes and latest " +
            pkg.name +
            "@" +
            pkg.version,
        );
        return meta;
      }
      if (![404, 429, 500, 502, 503, 504].includes(tar.status))
        throw Error("Public npm artifact lookup " + tar.status);
    } else if (![404, 429, 500, 502, 503, 504].includes(response.status))
      throw Error("Public npm lookup " + response.status);
    log("Public npm package pending verification " + (i + 1) + "/" + attempts);
    if (i + 1 < attempts) await sleep(delayMs);
  }
  throw Error(
    "npm upload accepted but public version/tarball is not verified; preserve original archive, query staged state, do not blindly republish",
  );
}
