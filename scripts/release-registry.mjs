import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { smokePackage } from "./package-smoke.mjs";
import { readVersions } from "./release-version.mjs";

export async function packageIntegrity(file) {
  return (
    "sha512-" +
    createHash("sha512")
      .update(await readFile(file))
      .digest("base64")
  );
}

export async function registryVersion(name, version, fetcher = fetch) {
  const response = await fetcher(
    "https://registry.npmjs.org/" +
      encodeURIComponent(name) +
      "/" +
      encodeURIComponent(version),
    { signal: AbortSignal.timeout(15000) },
  );
  if (response.status === 404) return null;
  assert.equal(
    response.ok,
    true,
    "Registry lookup failed; absence is not established.",
  );
  const data = await response.json();
  assert.equal(data.name, name);
  assert.equal(data.version, version);
  assert.equal(
    typeof data.dist?.integrity,
    "string",
    "Registry integrity is required.",
  );
  return data.dist.integrity;
}

export function requireFirstAttempt(attempt) {
  assert.equal(
    attempt,
    "1",
    "A rerun must not retry a possibly accepted publish. Inspect the registry and original artifact first.",
  );
}

export async function requireUnpublished(name, version, fetcher = fetch) {
  assert.equal(
    await registryVersion(name, version, fetcher),
    null,
    "Version already exists. Inspect the previous publication; do not republish.",
  );
}

export async function verifyPublication(
  name,
  version,
  integrity,
  { fetcher = fetch, pause = setTimeout, attempts = 10 } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const actual = await registryVersion(name, version, fetcher);
    if (actual !== null) {
      assert.equal(
        actual,
        integrity,
        "Registry bytes differ from the verified tarball.",
      );
      return;
    }
    if (attempt + 1 < attempts) await pause(6000);
  }
  throw new Error(
    "Exact registry version is not visible. Inspect publication before any retry.",
  );
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === "integrity") {
    console.log(await packageIntegrity(file));
    return;
  }
  const { manifest, version } = await readVersions();
  if (mode === "before") {
    requireFirstAttempt(process.env.GITHUB_RUN_ATTEMPT ?? "1");
    await requireUnpublished(manifest.name, version);
  } else if (mode === "after") {
    const integrity = await packageIntegrity(file);
    await verifyPublication(manifest.name, version, integrity);
    await smokePackage(manifest.name + "@" + version, version, integrity);
  } else
    throw new Error("Use before, after <tarball>, or integrity <tarball>.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
