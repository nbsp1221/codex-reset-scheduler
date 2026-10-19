import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ResetPlan } from "../../src/domain/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { LaunchdScheduler } from "../../src/scheduler/launchd.js";
import { SystemdScheduler } from "../../src/scheduler/systemd.js";
import type { ExecSpec } from "../../src/scheduler/types.js";
import { WindowsScheduler } from "../../src/scheduler/windows.js";
import type { CommandRunner } from "../../src/platform/command-runner.js";

const run: CommandRunner = () =>
  Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });

function plan(platform: ResetPlan["scheduler"]["platform"]): ResetPlan {
  return {
    planId: "plan-a",
    status: "armed",
    creditId: "synthetic-credit-secret",
    creditSelector: "abc123def456",
    resetType: "codexRateLimits",
    grantedAt: 1_000,
    expiresAt: 1_767_225_600,
    notBefore: 1_767_225_000,
    accountFingerprint: "fingerprint",
    runtimeVersion: "0.1.0",
    runtimeSha256: "a".repeat(64),
    codexExecutable: "/opt/codex",
    codexVersionAtArm: "codex-cli 1.0.0",
    codexHome: "/home/test/.codex",
    attempt: null,
    scheduler: {
      platform,
      artifactId: "artifact",
      triggerTimesUtc: ["2026-01-01T23:50:00.000Z", "2026-01-01T23:55:00.000Z"],
    },
    terminalReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const action: ExecSpec = {
  command: "/runtime/node path/node",
  arguments: ["/state/runtime/worker.js", "__worker", "--plan", "plan-a"],
  environment: { HOME: "/home/test", CODEX_HOME: "/home/test/.codex" },
  stateDirectory: "/home/test/.local/state/resetrail",
  codexHome: "/home/test/.codex",
  stdoutPath: "/logs/stdout.log",
  stderrPath: "/logs/stderr.log",
};

test("systemd artifacts contain exact triggers but no raw credit ID", () => {
  const scheduler = new SystemdScheduler(
    managedPaths({ platform: "linux", home: "/home/test", environment: {} }),
    run,
  );
  const preview = scheduler.preview(plan("systemd"), action);
  assert.equal(preview.artifactId, "resetrail-plan-a");
  const text = preview.files.map((file) => file.content).join("\n");
  assert.match(text, /OnCalendar=2026-01-01 23:50:00 UTC/);
  assert.match(text, /NoNewPrivileges=true/);
  assert.doesNotMatch(text, /synthetic-credit-secret/);
});

test("launchd artifacts use argument arrays and calendar intervals", () => {
  const scheduler = new LaunchdScheduler(
    managedPaths({ platform: "darwin", home: "/Users/test", environment: {} }),
    run,
    501,
  );
  const preview = scheduler.preview(plan("launchd"), action);
  assert.equal(preview.artifactId, "dev.resetrail.plan.plan-a");
  const text = preview.files[0]?.content ?? "";
  assert.match(text, /<key>ProgramArguments<\/key>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(text, /synthetic-credit-secret/);
});

test("Windows task is least-privilege, interactive, bounded, and secret-free", () => {
  const scheduler = new WindowsScheduler(run, "DOMAIN\\test");
  const preview = scheduler.preview(plan("task-scheduler"), action);
  assert.equal(preview.artifactId, "\\Resetrail\\plan-a");
  const text = preview.files[0]?.content ?? "";
  assert.match(text, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(
    text,
    /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/,
  );
  assert.match(text, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(text, /<DeleteExpiredTaskAfter>PT1M<\/DeleteExpiredTaskAfter>/);
  assert.doesNotMatch(text, /synthetic-credit-secret/);
});

test("Windows install creates its managed folder and remove cleans it only when empty", async () => {
  const calls: { executable: string; arguments: readonly string[] }[] = [];
  const inspectingRun: CommandRunner = (executable, arguments_) => {
    calls.push({ executable, arguments: arguments_ });
    return Promise.resolve({
      stdout:
        executable === "schtasks.exe" && arguments_.includes("/Query")
          ? "<Task/>"
          : "",
      stderr: "",
      exitCode: 0,
    });
  };
  const scheduler = new WindowsScheduler(inspectingRun, "DOMAIN\\test");
  await scheduler.install(plan("task-scheduler"), action);
  await scheduler.remove(plan("task-scheduler"));
  assert.equal(calls[0]?.executable, "powershell.exe");
  assert.match(calls[0].arguments.join(" "), /CreateFolder\('Resetrail'\)/u);
  assert.ok(
    calls.some(
      (call) =>
        call.executable === "schtasks.exe" &&
        call.arguments.includes("/Create"),
    ),
  );
  assert.match(
    calls.at(-1)?.arguments.join(" ") ?? "",
    /DeleteFolder\('Resetrail',0\)/u,
  );
});

test("Windows install writes Task Scheduler XML as UTF-16LE with a BOM", async () => {
  let registeredXml: Buffer | undefined;
  const inspectingRun: CommandRunner = async (executable, arguments_) => {
    if (executable === "schtasks.exe" && arguments_.includes("/Create")) {
      const xmlIndex = arguments_.indexOf("/XML");
      const path = arguments_[xmlIndex + 1];
      assert.ok(path);
      registeredXml = await readFile(path);
      assert.deepEqual([...registeredXml.subarray(0, 2)], [0xff, 0xfe]);
      const text = registeredXml.subarray(2).toString("utf16le");
      assert.match(text, /^<\?xml version="1\.0" encoding="UTF-16"\?>/u);
      assert.match(text, /<LogonType>InteractiveToken<\/LogonType>/u);
      assert.doesNotMatch(text, /synthetic-credit-secret/u);
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
  const scheduler = new WindowsScheduler(inspectingRun, "DOMAIN\\test");

  await scheduler.install(plan("task-scheduler"), action);

  assert.ok(registeredXml);
});
