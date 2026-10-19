import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  armResets,
  type ArmDependencies,
} from "../../src/application/arm-service.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { installRuntimeSnapshot } from "../../src/runtime/installer.js";
import { systemdQuote } from "../../src/scheduler/escaping.js";
import { SystemdScheduler } from "../../src/scheduler/systemd.js";
import type { ExecSpec, SchedulerAdapter } from "../../src/scheduler/types.js";

for (const custom of [true, false]) {
  test(`systemd action pins ${custom ? "custom" : "default"} XDG locations in its environment`, async () => {
    const harness = await createHarness("linux", custom);
    try {
      await armResets(
        { all: false, beforeSeconds: 600, dryRun: false },
        harness.dependencies,
      );
      const action = harness.actions[0];
      assert.ok(action);
      const derived = managedPaths({
        platform: "linux",
        home: harness.home,
        environment: action.environment,
      });
      assert.deepEqual(derived, harness.dependencies.paths);
      // Explicit defaults also override conflicting environment inherited from a manager.
      const hostileManager = {
        XDG_STATE_HOME: join(harness.home, "other-state"),
        XDG_CONFIG_HOME: join(harness.home, "other-config"),
        ...action.environment,
      };
      assert.deepEqual(
        managedPaths({
          platform: "linux",
          home: harness.home,
          environment: hostileManager,
        }),
        harness.dependencies.paths,
      );
      const plan = (await harness.dependencies.store.load())?.plans[0];
      assert.ok(plan);
      const service = new SystemdScheduler(harness.dependencies.paths, () => {
        throw new Error("native command must not run");
      }).preview(plan, action).files[0]?.content;
      assert.ok(service);
      const stateBase = action.environment.XDG_STATE_HOME;
      const configBase = action.environment.XDG_CONFIG_HOME;
      assert.ok(stateBase);
      assert.ok(configBase);
      assert.ok(
        service.includes(
          `Environment=${systemdQuote(`XDG_STATE_HOME=${stateBase}`)}`,
        ),
      );
      assert.ok(
        service.includes(
          `Environment=${systemdQuote(`XDG_CONFIG_HOME=${configBase}`)}`,
        ),
      );
      if (custom) assert.ok(service.includes("%%value"));
      await access(derived.stateFile);
    } finally {
      await harness.cleanup();
    }
  });
}

test(
  "scheduled Linux CLI finds its armed state with only its generated environment",
  { skip: process.platform !== "linux" },
  async () => {
    const harness = await createHarness("linux", true);
    try {
      await armResets(
        { all: false, beforeSeconds: 600, dryRun: false },
        {
          ...harness.dependencies,
          installRuntime: installRuntimeSnapshot,
        },
      );
      const action = harness.actions[0];
      assert.ok(action);
      // A paused plan proves real CLI lookup without connecting to any backend.
      await harness.dependencies.store.withLock(async (locked) => {
        const state = locked.get();
        await locked.save({
          ...state,
          revision: state.revision + 1,
          plans: state.plans.map((plan) => ({
            ...plan,
            status: "paused",
            terminalReason: "synthetic_no_backend",
          })),
        });
      });
      const { stdout, stderr } = await promisify(execFile)(
        action.command,
        [...action.arguments, "--json"],
        { env: { ...action.environment }, timeout: 10_000 },
      );
      assert.equal(stderr, "");
      const result = JSON.parse(stdout) as {
        ok: boolean;
        data: { planId: string; status: string; event: string };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data.planId, action.arguments.at(-1));
      assert.equal(result.data.status, "paused");
      assert.equal(result.data.event, "terminal-noop");
      const defaultPaths = managedPaths({
        platform: "linux",
        home: harness.home,
        environment: {},
      });
      await assert.rejects(access(defaultPaths.stateFile), { code: "ENOENT" });
    } finally {
      await harness.cleanup();
    }
  },
);

for (const platform of ["darwin", "win32"] as const) {
  test(`${platform} action keeps its existing environment without Linux XDG overrides`, async () => {
    const harness = await createHarness(platform, false);
    try {
      await armResets(
        { all: false, beforeSeconds: 600, dryRun: false },
        harness.dependencies,
      );
      const action = harness.actions[0];
      assert.ok(action);
      assert.deepEqual(Object.keys(action.environment).toSorted(), [
        "CODEX_HOME",
        "HOME",
        "PATH",
      ]);
      assert.equal(
        action.stateDirectory,
        harness.dependencies.paths.stateDirectory,
      );
      assert.equal(action.codexHome, harness.dependencies.codexHome);
      assert.equal(action.environment.HOME, harness.home);
    } finally {
      await harness.cleanup();
    }
  });
}

async function createHarness(platform: NodeJS.Platform, custom: boolean) {
  const home = await mkdtemp(join(tmpdir(), "resetrail-environment-"));
  const paths = managedPaths({
    platform,
    home,
    environment: custom
      ? {
          XDG_STATE_HOME: join(home, "custom state %value"),
          XDG_CONFIG_HOME: join(home, "custom config %value"),
        }
      : {},
  });
  const actions: ExecSpec[] = [];
  const scheduler: SchedulerAdapter = {
    preview: (plan) => ({
      platform: paths.platform,
      artifactId: plan.planId,
      files: [],
      registration: { executable: "synthetic", arguments: [] },
    }),
    install: (_plan, action) => {
      actions.push(action);
      return Promise.resolve();
    },
    inspect: () =>
      Promise.resolve({ installed: true, enabled: true, detail: "synthetic" }),
    remove: () => Promise.resolve(),
  };
  const now = new Date("2026-01-01T00:00:00.000Z");
  const seconds = Math.floor(now.getTime() / 1_000);
  const dependencies: ArmDependencies = {
    paths,
    store: new StateStore(paths),
    scheduler,
    installRuntime: () =>
      Promise.resolve({
        version: "0.1.0",
        sha256: "a".repeat(64),
        directory: join(paths.runtimeDirectory, "synthetic"),
        entrypoint: join(paths.runtimeDirectory, "synthetic", "cli.js"),
      }),
    now: () => now,
    nodeExecutable: process.execPath,
    home,
    codexHome: join(home, ".codex"),
    connect: () =>
      Promise.resolve({
        executable: "/synthetic/codex-not-executed",
        version: "synthetic",
        client: {
          readAccount: () =>
            Promise.resolve({
              type: "chatgpt",
              email: "synthetic@example.invalid",
              planType: "pro",
            }),
          readRateLimits: () =>
            Promise.resolve({
              primary: null,
              secondary: null,
              resetCredits: {
                availableCount: 1,
                detailsComplete: true,
                credits: [
                  {
                    id: "synthetic-environment-credit",
                    status: "available",
                    resetType: "codexRateLimits",
                    grantedAt: seconds - 1_000,
                    expiresAt: seconds + 3_600,
                    title: null,
                    description: null,
                  },
                ],
              },
            }),
          close: () => Promise.resolve(),
        },
      }),
  };
  return {
    home,
    actions,
    dependencies,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
