import assert from "node:assert/strict";
import test from "node:test";

import {
  runCli,
  type CliDependencies,
  type ReadSession,
} from "../../src/cli-core.js";
import type { RateLimitsSnapshot } from "../../src/domain/types.js";
import { VERSION } from "../../src/version.js";

const future = Math.floor(Date.now() / 1_000) + 3_600;

function session(): ReadSession {
  const snapshot: RateLimitsSnapshot = {
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: future },
    secondary: null,
    resetCredits: {
      availableCount: 1,
      detailsComplete: true,
      credits: [
        {
          id: "synthetic-credit-cli",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: future - 1_000,
          expiresAt: future,
          title: null,
          description: null,
        },
      ],
    },
  };
  return {
    executable: "/synthetic/codex",
    version: "codex-cli 1.0.0",
    readAccount: () =>
      Promise.resolve({
        type: "chatgpt",
        email: "synthetic@example.invalid",
        planType: "pro",
      }),
    readRateLimits: () => Promise.resolve(snapshot),
    close: () => Promise.resolve(),
  };
}

function harness(): {
  dependencies: CliDependencies;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      connect: () => Promise.resolve(session()),
      now: () => new Date((future - 1_800) * 1_000),
      platform: "linux",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

test("resets JSON exposes selectors but not raw credit IDs or email", async () => {
  const { dependencies, stdout } = harness();
  assert.equal(
    await runCli(["resets", "--json", "--timezone", "UTC"], dependencies),
    0,
  );
  const output = stdout.join("");
  assert.doesNotMatch(output, /synthetic-credit-cli/);
  assert.doesNotMatch(output, /synthetic@example/);
  assert.match(output, /availableCount/);
});

test("plan is explicitly dry-run and creates no mutation surface", async () => {
  const { dependencies, stdout } = harness();
  assert.equal(
    await runCli(["plan", "--json", "--timezone", "UTC"], dependencies),
    0,
  );
  const parsed = JSON.parse(stdout.join("")) as {
    data: {
      dryRun: boolean;
      plannedResetCount: number;
      plans: { nativeScheduler: string }[];
    };
  };
  assert.equal(parsed.data.dryRun, true);
  assert.equal(parsed.data.plannedResetCount, 1);
  assert.equal(
    parsed.data.plans[0]?.nativeScheduler,
    "systemd user service and timer",
  );
});

test("help documents every confirmation and machine-output option", async () => {
  const { dependencies, stdout } = harness();
  assert.equal(await runCli(["--help"], dependencies), 0);
  const output = stdout.join("");
  assert.match(output, /^codex-reset-scheduler /u);
  assert.match(
    output,
    /codex-reset-scheduler arm .* \[--yes\] \[--dry-run\] \[--json\]/u,
  );
  assert.match(
    output,
    /codex-reset-scheduler disarm .* \[--yes\] \[--dry-run\] \[--json\]/u,
  );
  assert.match(
    output,
    /codex-reset-scheduler logs \[--plan <id-or-selector>\]/u,
  );
});

test("doctor returns a failing health status when a required scheduler check fails", async () => {
  const { dependencies, stdout } = harness();
  const exitCode = await runCli(["doctor"], {
    ...dependencies,
    inspectScheduler: () =>
      Promise.resolve({
        platform: "linux",
        scheduler: "systemd",
        ready: false,
        checks: [
          {
            name: "systemd-user-manager",
            required: true,
            ok: false,
            hint: "Start the user manager.",
          },
        ],
      }),
  });
  assert.equal(exitCode, 1);
  assert.match(stdout.join(""), /doctor: ATTENTION/u);
  assert.match(stdout.join(""), /systemd-user-manager \(required\)/u);
});

test("interactive JSON arming is rejected before any mutation path", async () => {
  const { dependencies, stdout, stderr } = harness();
  const exitCode = await runCli(["arm", "--json"], dependencies);
  assert.equal(exitCode, 2);
  assert.deepEqual(stdout, []);
  const error = JSON.parse(stderr.join("")) as {
    error: { code: string };
  };
  assert.equal(error.error.code, "confirmation_required");
});

test("version and human errors use the new CLI name without account access", async () => {
  const { dependencies, stdout, stderr } = harness();
  const isolated = {
    ...dependencies,
    connect: () => {
      throw new Error("This command must not connect to an account.");
    },
  };
  assert.equal(await runCli(["version"], isolated), 0);
  assert.equal(stdout.join(""), `codex-reset-scheduler ${VERSION}\n`);
  assert.equal(await runCli(["unknown-command"], isolated), 1);
  assert.match(stderr.join(""), /^codex-reset-scheduler: /u);
});
