import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const versionPattern = new RegExp(
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-" +
    identifier +
    "(?:\\." +
    identifier +
    ")*)?$",
);

export function packageVersion(manifest) {
  assert.equal(manifest.name, "codex-reset-scheduler");
  assert.equal(typeof manifest.version, "string");
  assert.match(
    manifest.version,
    versionPattern,
    "Use a stable or prerelease SemVer without build metadata.",
  );
  return manifest.version;
}

export function releaseTarget(version, event) {
  assert.equal(event.deleted, false, "A deleted tag cannot publish npm.");
  assert.equal(
    event.ref,
    "refs/tags/v" + version,
    "Pushed tag must exactly match the manifest.",
  );
  return {
    version,
    tag: "v" + version,
    distTag: version.includes("-") ? "next" : "latest",
  };
}

export function requireVerifiedCI(runs, sha) {
  // The API lists newest runs first. An older green run cannot mask a newer one.
  const latest = runs.find(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === "main" &&
      run.event === "push",
  );
  assert.equal(
    latest?.status,
    "completed",
    "The exact main commit's latest CI must finish.",
  );
  assert.equal(
    latest.conclusion,
    "success",
    "The exact main commit's latest CI must succeed.",
  );
}

export async function readVersion() {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  return { manifest, version: packageVersion(manifest) };
}

async function main() {
  const { version } = await readVersion();
  if (process.argv[2] === "generate") {
    await writeFile(
      new URL("../src/version.ts", import.meta.url),
      `export const VERSION = ${JSON.stringify(version)};\n`,
    );
    return;
  }
  if (process.argv[2] !== "workflow") {
    console.log("Package version verified: " + version);
    return;
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const sha = git("rev-parse", "HEAD");
  assert.equal(
    sha,
    git("rev-parse", "--verify", process.env.GITHUB_SHA + "^{commit}"),
    "Checkout must be pinned to the event SHA.",
  );
  let target = { version, distTag: version.includes("-") ? "next" : "latest" };
  if (process.env.GITHUB_EVENT_NAME === "push") {
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    target = releaseTarget(version, event);
    assert.equal(
      event.ref,
      process.env.GITHUB_REF,
      "Push payload and workflow ref must agree.",
    );
    assert.equal(
      git("rev-parse", "--verify", "refs/tags/" + target.tag + "^{commit}"),
      sha,
    );
    git("merge-base", "--is-ancestor", sha, "origin/main");
    const endpoint = `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`;
    const response = JSON.parse(
      execFileSync("gh", ["api", endpoint], { encoding: "utf8" }),
    );
    requireVerifiedCI(response.workflow_runs, sha);
  } else
    assert.equal(
      process.env.GITHUB_EVENT_NAME,
      "workflow_dispatch",
      "Unsupported release verification event.",
    );
  assert.ok(process.env.GITHUB_OUTPUT);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    "version=" +
      version +
      "\ndist-tag=" +
      target.distTag +
      "\nsha=" +
      sha +
      "\n",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
