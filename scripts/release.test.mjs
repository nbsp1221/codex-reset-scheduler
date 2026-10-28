import assert from "node:assert/strict";
import test from "node:test";

import {
  coherentVersion,
  readVersions,
  releaseTarget,
  requireVerifiedCI,
} from "./release-version.mjs";
import {
  registryVersion,
  requireFirstAttempt,
  requireUnpublished,
  verifyPublication,
} from "./release-registry.mjs";

const manifest = (version) => ({ name: "codex-reset-scheduler", version });
const source = (version) => 'export const VERSION = "' + version + '";';
const event = (tag, prerelease = false) => ({
  action: "published",
  release: { draft: false, tag_name: tag, prerelease },
});

test("the actual manifest and standalone runtime version agree", async () => {
  const actual = await readVersions();
  assert.equal(actual.version, actual.manifest.version);
});

test("release metadata rejects version drift and malformed versions", () => {
  assert.throws(() => coherentVersion(manifest("0.2.0"), source("0.1.0")));
  for (const version of [
    "01.2.3",
    "1.2",
    "1.2.3-01",
    "1.2.3+build",
    "1.2.3\nsha=evil",
  ])
    assert.throws(() => coherentVersion(manifest(version), source(version)));
  for (const version of ["0.1.0", "1.0.0-rc.1", "2.0.0-beta"])
    assert.equal(coherentVersion(manifest(version), source(version)), version);
});

test("only exact published tags preserve stable and prerelease channels", () => {
  assert.deepEqual(releaseTarget("0.1.0", event("v0.1.0")), {
    version: "0.1.0",
    tag: "v0.1.0",
    distTag: "latest",
  });
  assert.equal(
    releaseTarget("0.2.0-rc.1", event("v0.2.0-rc.1", true)).distTag,
    "next",
  );
  for (const input of [
    event("v0.2.0"),
    event("0.1.0"),
    event("v0.1.0", true),
    { ...event("v0.1.0"), action: "created" },
    {
      action: "published",
      release: { draft: true, tag_name: "v0.1.0", prerelease: false },
    },
  ])
    assert.throws(() => releaseTarget("0.1.0", input));
  assert.throws(() => releaseTarget("0.2.0-rc.1", event("v0.2.0-rc.1")));
});

test("a green CI run must belong to the exact main commit", () => {
  const run = {
    head_sha: "a".repeat(40),
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  requireVerifiedCI([run], run.head_sha);
  assert.throws(() =>
    requireVerifiedCI([{ ...run, conclusion: "failure" }, run], run.head_sha),
  );
  assert.throws(() =>
    requireVerifiedCI([{ ...run, status: "in_progress" }, run], run.head_sha),
  );
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
  ])
    assert.throws(() =>
      requireVerifiedCI([{ ...run, ...patch }], run.head_sha),
    );
});

const missing = async () => new Response("", { status: 404 });
const present = (integrity) => async () =>
  Response.json({
    name: "codex-reset-scheduler",
    version: "0.1.0",
    dist: { integrity },
  });

test("only an exact registry 404 permits a first publish attempt", async () => {
  await requireUnpublished("codex-reset-scheduler", "0.1.0", missing);
  await assert.rejects(
    requireUnpublished(
      "codex-reset-scheduler",
      "0.1.0",
      present("sha512-synthetic"),
    ),
  );
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      requireUnpublished(
        "codex-reset-scheduler",
        "0.1.0",
        async () => new Response("", { status }),
      ),
    );
  await assert.rejects(
    registryVersion("codex-reset-scheduler", "0.1.0", async () =>
      Response.json({ name: "other", version: "0.1.0", dist: {} }),
    ),
  );
});

test("registry propagation retries reads, never a publication", async () => {
  let reads = 0;
  const pauses = [];
  await verifyPublication(
    "codex-reset-scheduler",
    "0.1.0",
    "sha512-synthetic",
    {
      fetcher: (...args) =>
        ++reads < 3 ? missing(...args) : present("sha512-synthetic")(...args),
      pause: (duration) => {
        pauses.push(duration);
        return Promise.resolve();
      },
    },
  );
  assert.equal(reads, 3);
  assert.deepEqual(pauses, [6000, 6000]);
  await assert.rejects(
    verifyPublication("codex-reset-scheduler", "0.1.0", "sha512-synthetic", {
      fetcher: missing,
      pause: () => Promise.resolve(),
      attempts: 2,
    }),
    /Inspect publication/,
  );
  await assert.rejects(
    verifyPublication("codex-reset-scheduler", "0.1.0", "sha512-synthetic", {
      fetcher: present("sha512-different"),
      pause: () => {
        throw new Error("Must not retry mismatched bytes.");
      },
    }),
    /differ/,
  );
});

test("a workflow rerun cannot repeat an uncertain publication", () => {
  requireFirstAttempt("1");
  for (const attempt of ["2", "3", "", "unknown"])
    assert.throws(() => requireFirstAttempt(attempt), /possibly accepted/);
});
