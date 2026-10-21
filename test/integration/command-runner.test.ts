import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runCommand } from "../../src/platform/command-runner.js";

test("command timeout is failure even when SIGTERM handler exits zero", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(0), 4000);",
    ],
    { timeoutMilliseconds: 500, allowFailure: true },
  );
  assert.equal(result.exitCode, 1);
});

test("command timeout forcibly stops a child that ignores SIGTERM", async () => {
  const started = Date.now();
  await assert.rejects(
    runCommand(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 4000);",
      ],
      { timeoutMilliseconds: 500 },
    ),
    { code: "scheduler_command_failed" },
  );
  assert.ok(Date.now() - started < 3_000);
});

test("spawn errors clear the command timer rather than keeping the process alive", () => {
  const moduleUrl = new URL(
    "../../src/platform/command-runner.js",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { runCommand } from ${JSON.stringify(moduleUrl)}; await runCommand('/nonexistent-resetrail-synthetic-command', []).catch(() => {});`,
    ],
    { timeout: 3_000, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("command runner collects complete output and preserves ordinary failures", async () => {
  const success = await runCommand(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(32000)); process.stderr.write('warning');",
  ]);
  assert.equal(success.stdout.length, 32000);
  assert.equal(success.stderr, "warning");
  assert.equal(success.exitCode, 0);
  const failure = await runCommand(
    process.execPath,
    ["-e", "process.exit(7)"],
    { allowFailure: true },
  );
  assert.equal(failure.exitCode, 7);
});

test("timeout remains bounded when descendants inherit command output pipes", async () => {
  const started = Date.now();
  const descendant = "setTimeout(() => {}, 3000)";
  // Windows needs a detached descendant to outlive its parent.
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: ['ignore', process.stdout, process.stderr] }); process.stdout.write('descendant-spawned'); process.exit(0);`;
  const result = await runCommand(process.execPath, ["-e", parent], {
    timeoutMilliseconds: 500,
    allowFailure: true,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "descendant-spawned");
  assert.ok(Date.now() - started < 2_500);
});
