import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readVersion } from "./release-version.mjs";

export async function ensureGitHubRelease(version, { lookup, create }) {
  const tag = "v" + version;
  const prerelease = version.includes("-");
  const response = await lookup(tag);
  if (response.status === 404) {
    await create([
      "release",
      "create",
      tag,
      "--verify-tag",
      "--title",
      tag,
      "--generate-notes",
      ...(prerelease ? ["--prerelease"] : []),
    ]);
    return;
  }
  assert.equal(
    response.ok,
    true,
    "Release lookup failed; do not assume absence.",
  );
  const release = await response.json();
  assert.equal(release.tag_name, tag);
  assert.equal(
    release.draft,
    false,
    "An existing draft requires owner attention.",
  );
  assert.equal(
    release.prerelease,
    prerelease,
    "Existing Release channel must match SemVer.",
  );
  console.log("The matching published GitHub Release already exists.");
}

async function main() {
  const { version } = await readVersion();
  assert.ok(process.env.GH_TOKEN);
  assert.ok(process.env.GITHUB_REPOSITORY);
  await ensureGitHubRelease(version, {
    lookup: (tag) =>
      fetch(
        (process.env.GITHUB_API_URL ?? "https://api.github.com") +
          "/repos/" +
          process.env.GITHUB_REPOSITORY +
          "/releases/tags/" +
          encodeURIComponent(tag),
        {
          headers: {
            Authorization: "Bearer " + process.env.GH_TOKEN,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(15000),
        },
      ),
    create: (args) => execFileSync("gh", args, { stdio: "inherit" }),
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
