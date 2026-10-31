import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import test from "node:test";

import {
  packageVersion,
  readVersion,
  releaseTarget,
  requireVerifiedCI,
} from "./release-version.mjs";
import {
  registryVersion,
  requireSafePublishAttempt,
  requireUnpublished,
  verifyPublication,
} from "./release-registry.mjs";

import { ensureGitHubRelease } from "./release-github.mjs";

const manifest = (version) => ({ name: "codex-reset-scheduler", version });
const source = (version) => 'export const VERSION = "' + version + '";';
const event = (tag, deleted = false) => ({ ref: "refs/tags/" + tag, deleted });

test("release metadata uses the actual manifest version", async () => {
  const actual = await readVersion();
  assert.equal(actual.version, actual.manifest.version);
});

test("build version generation follows manifest-only version changes", async () => {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "scheduler-version-")),
  );
  try {
    await mkdir(join(temporary, "scripts"));
    await mkdir(join(temporary, "src"));
    await cp(
      new URL("./release-version.mjs", import.meta.url),
      join(temporary, "scripts", "release-version.mjs"),
    );
    for (const version of ["0.1.0", "0.2.0-rc.1"]) {
      await writeFile(
        join(temporary, "package.json"),
        JSON.stringify(manifest(version)),
      );
      execFileSync(
        process.execPath,
        [join(temporary, "scripts", "release-version.mjs"), "generate"],
        { cwd: temporary, stdio: "pipe" },
      );
      assert.equal(
        await readFile(join(temporary, "src", "version.ts"), "utf8"),
        source(version) + "\n",
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release metadata rejects invalid package names and malformed versions", () => {
  assert.throws(() =>
    packageVersion({ name: "other-package", version: "0.1.0" }),
  );
  for (const version of [
    "01.2.3",
    "1.2",
    "1.2.3-01",
    "1.2.3+build",
    "1.2.3\nsha=evil",
  ])
    assert.throws(() => packageVersion(manifest(version)));
  for (const version of ["0.1.0", "1.0.0-rc.1", "2.0.0-beta"])
    assert.equal(packageVersion(manifest(version)), version);
});

test("only exact live tag pushes preserve stable and prerelease channels", () => {
  assert.deepEqual(releaseTarget("0.1.0", event("v0.1.0")), {
    version: "0.1.0",
    tag: "v0.1.0",
    distTag: "latest",
  });
  assert.equal(
    releaseTarget("0.2.0-rc.1", event("v0.2.0-rc.1")).distTag,
    "next",
  );
  for (const input of [
    event("v0.2.0"),
    event("0.1.0"),
    event("v0.1.0", true),
    { ref: "refs/heads/v0.1.0", deleted: false },
    { action: "published", release: { tag_name: "v0.1.0", draft: false } },
  ])
    assert.throws(() => releaseTarget("0.1.0", input));
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

const skippedPublisher = {
  name: "publish",
  status: "completed",
  conclusion: "skipped",
};

test("a first attempt does not need history; verification-only failures can resume", () => {
  requireSafePublishAttempt("1", () => {
    throw new Error("First attempt must not query history.");
  });
  const inspected = [];
  requireSafePublishAttempt("3", (attempt) => {
    inspected.push(attempt);
    return [
      { name: "verify / verify", status: "completed", conclusion: "failure" },
      skippedPublisher,
    ];
  });
  assert.deepEqual(inspected, [1, 2]);
});

test("a rerun rejects attempted, ambiguous, or missing publication history", () => {
  for (const jobs of [
    [],
    [skippedPublisher, skippedPublisher],
    [{ ...skippedPublisher, name: "another-job" }],
    [{ ...skippedPublisher, status: "in_progress" }],
    ...["success", "failure", "cancelled", null].map((conclusion) => [
      { ...skippedPublisher, conclusion },
    ]),
  ]) {
    assert.throws(
      () => requireSafePublishAttempt("2", () => jobs),
      /proven skipped/,
    );
  }
  // A skipped latest attempt cannot conceal an older actual publication.
  assert.throws(
    () =>
      requireSafePublishAttempt("3", (attempt) => [
        {
          ...skippedPublisher,
          conclusion: attempt === 1 ? "success" : "skipped",
        },
      ]),
    /proven skipped/,
  );
  assert.throws(
    () =>
      requireSafePublishAttempt("2", () => {
        throw new Error("GitHub API unavailable");
      }),
    /GitHub API unavailable/,
  );
  for (const attempt of [
    "0",
    "-1",
    "",
    "unknown",
    "2x",
    "1.5",
    "9007199254740992",
  ])
    assert.throws(
      () => requireSafePublishAttempt(attempt),
      /Invalid workflow attempt/,
    );
});

test("a missing Release is created once with generated notes and the right channel", async () => {
  for (const version of ["0.1.0", "0.2.0-rc.1"]) {
    const calls = [];
    await ensureGitHubRelease(version, {
      lookup: (tag) => {
        assert.equal(tag, "v" + version);
        return missing();
      },
      create: (args) => {
        calls.push(args);
        return Promise.resolve();
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "release",
      "create",
      "v" + version,
      "--verify-tag",
      "--title",
      "v" + version,
      "--generate-notes",
      ...(version.includes("-") ? ["--prerelease"] : []),
    ]);
  }
});

test("a release-job rerun accepts the matching public Release without another write", async () => {
  await ensureGitHubRelease("0.1.0", {
    lookup: () =>
      Promise.resolve(
        Response.json({ tag_name: "v0.1.0", draft: false, prerelease: false }),
      ),
    create: () => {
      throw new Error("Must not create a duplicate Release.");
    },
  });
});

test("Release lookup errors and mismatched existing metadata never authorize creation", async () => {
  for (const response of [
    new Response("", { status: 403 }),
    new Response("", { status: 500 }),
    Response.json({ tag_name: "v0.2.0", draft: false, prerelease: false }),
    Response.json({ tag_name: "v0.1.0", draft: true, prerelease: false }),
    Response.json({ tag_name: "v0.1.0", draft: false, prerelease: true }),
  ]) {
    let writes = 0;
    await assert.rejects(
      ensureGitHubRelease("0.1.0", {
        lookup: () => Promise.resolve(response),
        create: () => {
          writes += 1;
          return Promise.resolve();
        },
      }),
    );
    assert.equal(writes, 0);
  }
});
