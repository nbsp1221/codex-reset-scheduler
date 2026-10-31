import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { smokePackage } from "./package-smoke.mjs";
import { readVersion } from "./release-version.mjs";

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

function jobsForAttempt(attempt) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env;
  assert.ok(repository, "Workflow repository is required.");
  assert.match(runId ?? "", /^[1-9][0-9]*$/u, "Workflow run ID is required.");
  const pages = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
        "--paginate",
        "--slurp",
      ],
      { encoding: "utf8" },
    ),
  );
  return pages.flatMap((page) => page.jobs);
}

export function requireSafePublishAttempt(attempt, loadJobs = jobsForAttempt) {
  assert.match(attempt, /^[1-9][0-9]*$/u, "Invalid workflow attempt.");
  const current = Number(attempt);
  assert.ok(Number.isSafeInteger(current), "Invalid workflow attempt.");
  for (let previous = 1; previous < current; previous += 1) {
    const publishers = loadJobs(previous).filter(
      (job) => job.name === "publish",
    );
    assert.ok(
      publishers.length === 1 &&
        publishers[0].status === "completed" &&
        publishers[0].conclusion === "skipped",
      "A prior publish job was not proven skipped. Inspect the registry and original artifact before retrying.",
    );
  }
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
  const { manifest, version } = await readVersion();
  if (mode === "before") {
    requireSafePublishAttempt(process.env.GITHUB_RUN_ATTEMPT ?? "1");
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
