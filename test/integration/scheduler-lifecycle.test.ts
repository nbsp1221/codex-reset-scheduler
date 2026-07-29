import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { creditSelector } from "../../src/domain/policy.js";
import type { ResetPlan } from "../../src/domain/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import type { CommandRunner } from "../../src/platform/command-runner.js";
import { LaunchdScheduler } from "../../src/scheduler/launchd.js";
import { SystemdScheduler } from "../../src/scheduler/systemd.js";
import type { ExecSpec } from "../../src/scheduler/types.js";

test("systemd adapter installs, reads back, and removes managed artifacts", async () => {
  const home = await mkdtemp(join(tmpdir(), "resetrail-systemd-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const calls: string[] = [];
  const run: CommandRunner = (executable, arguments_) => {
    calls.push(`${executable} ${arguments_.join(" ")}`);
    const show = executable === "systemctl" && arguments_.includes("show");
    return Promise.resolve({
      stdout: show
        ? "LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n"
        : "",
      stderr: "",
      exitCode: 0,
    });
  };
  const scheduler = new SystemdScheduler(paths, run);
  const resetPlan = plan("systemd", home);
  try {
    const preview = scheduler.preview(resetPlan, action(home));
    await scheduler.install(resetPlan, action(home));
    const service = preview.files[0];
    assert.ok(service);
    assert.match(await readFile(service.path, "utf8"), /Type=oneshot/u);
    assert.equal(
      (await scheduler.inspect(resetPlan)).detail,
      "loaded user timer",
    );
    await scheduler.remove(resetPlan);
    for (const file of preview.files)
      await assert.rejects(() => readFile(file.path), { code: "ENOENT" });
    assert.ok(calls.some((call) => call.startsWith("systemd-analyze ")));
    assert.ok(calls.some((call) => call.includes("enable --now")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("launchd adapter validates, bootstraps, reads back, and removes its plist", async () => {
  const home = await mkdtemp(join(tmpdir(), "resetrail-launchd-"));
  const paths = managedPaths({ platform: "darwin", home, environment: {} });
  const calls: string[] = [];
  const run: CommandRunner = (executable, arguments_) => {
    calls.push(`${executable} ${arguments_.join(" ")}`);
    return Promise.resolve({ stdout: "registered", stderr: "", exitCode: 0 });
  };
  const scheduler = new LaunchdScheduler(paths, run, 501);
  const resetPlan = plan("launchd", home);
  try {
    const preview = scheduler.preview(resetPlan, action(home));
    await scheduler.install(resetPlan, action(home));
    const plist = preview.files[0];
    assert.ok(plist);
    assert.match(await readFile(plist.path, "utf8"), /RunAtLoad/u);
    assert.equal(
      (await scheduler.inspect(resetPlan)).detail,
      "registered LaunchAgent",
    );
    await scheduler.remove(resetPlan);
    await assert.rejects(() => readFile(plist.path), { code: "ENOENT" });
    assert.ok(calls.some((call) => call.startsWith("/usr/bin/plutil -lint")));
    assert.ok(calls.some((call) => call.includes("launchctl bootstrap")));
    assert.ok(calls.some((call) => call.includes("launchctl bootout")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function plan(
  platform: ResetPlan["scheduler"]["platform"],
  home: string,
): ResetPlan {
  const creditId = "synthetic-scheduler-credit";
  return {
    planId: "00000000-0000-4000-8000-000000000030",
    status: "armed",
    creditId,
    creditSelector: creditSelector(creditId),
    resetType: "codexRateLimits",
    grantedAt: 1_000,
    expiresAt: 1_767_225_600,
    notBefore: 1_767_225_000,
    accountFingerprint: "a".repeat(64),
    runtimeVersion: "0.1.0",
    runtimeSha256: "b".repeat(64),
    codexExecutable: join(home, "codex"),
    codexVersionAtArm: "synthetic",
    codexHome: join(home, ".codex"),
    attempt: null,
    scheduler: {
      platform,
      artifactId: "00000000-0000-4000-8000-000000000030",
      triggerTimesUtc: ["2026-01-01T23:50:00.000Z"],
    },
    terminalReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function action(home: string): ExecSpec {
  return {
    command: process.execPath,
    arguments: [
      join(home, "runtime", "cli.js"),
      "__worker",
      "--plan",
      "opaque",
    ],
    environment: { HOME: home, CODEX_HOME: join(home, ".codex") },
    stateDirectory: join(home, "state"),
    codexHome: join(home, ".codex"),
    stdoutPath: join(home, "stdout.log"),
    stderrPath: join(home, "stderr.log"),
  };
}
