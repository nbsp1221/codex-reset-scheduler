import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  armResets,
  type ArmDependencies,
  type ArmLiveCodex,
} from "../../src/application/arm-service.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import type {
  SchedulerAdapter,
  SchedulerPreview,
} from "../../src/scheduler/types.js";

test("arm --all persists independent exact plans without a consume capability", async () => {
  const home = await mkdtemp(join(tmpdir(), "resetrail-arm-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  const installed: string[] = [];
  const scheduler: SchedulerAdapter = {
    preview: (plan): SchedulerPreview => ({
      platform: "systemd",
      artifactId: plan.planId,
      files: [],
      registration: { executable: "synthetic", arguments: [] },
    }),
    install: (plan) => {
      installed.push(plan.planId);
      return Promise.resolve();
    },
    inspect: () =>
      Promise.resolve({ installed: true, enabled: true, detail: "synthetic" }),
    remove: () => Promise.resolve(),
  };
  const now = new Date("2026-01-01T00:00:00.000Z");
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const live: ArmLiveCodex = {
    executable: "/synthetic/codex",
    version: "codex-cli 1.0.0",
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
            availableCount: 2,
            detailsComplete: true,
            credits: [
              syntheticCredit("synthetic-a", nowSeconds + 3_600),
              syntheticCredit("synthetic-b", nowSeconds + 7_200),
            ],
          },
        }),
      close: () => Promise.resolve(),
    },
  };
  const dependencies: ArmDependencies = {
    paths,
    store,
    scheduler,
    connect: () => Promise.resolve(live),
    installRuntime: () =>
      Promise.resolve({
        version: "0.1.0",
        sha256: "a".repeat(64),
        directory: join(home, "runtime"),
        entrypoint: join(home, "runtime", "cli.js"),
      }),
    now: () => now,
    nodeExecutable: process.execPath,
    codexHome: join(home, ".codex"),
    home,
  };
  try {
    const result = await armResets(
      { all: true, beforeSeconds: 600, dryRun: false },
      dependencies,
    );
    assert.equal(result.plans.length, 2);
    assert.equal(installed.length, 2);
    const state = await store.load();
    assert.ok(state);
    assert.equal(state.plans.length, 2);
    assert.notEqual(state.plans[0]?.planId, state.plans[1]?.planId);
    assert.deepEqual(
      new Set(state.plans.map((plan) => plan.creditId)),
      new Set(["synthetic-a", "synthetic-b"]),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("scheduler failure removes every intended artifact and pauses every plan", async () => {
  const home = await mkdtemp(join(tmpdir(), "resetrail-arm-rollback-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  const removed: string[] = [];
  let installs = 0;
  const scheduler: SchedulerAdapter = {
    preview: (plan) => ({
      platform: "systemd",
      artifactId: plan.planId,
      files: [],
      registration: { executable: "synthetic", arguments: [] },
    }),
    install: () => {
      installs += 1;
      return installs === 2
        ? Promise.reject(new Error("synthetic scheduler failure"))
        : Promise.resolve();
    },
    inspect: () =>
      Promise.resolve({ installed: true, enabled: true, detail: "synthetic" }),
    remove: (plan) => {
      removed.push(plan.planId);
      return Promise.resolve();
    },
  };
  const now = new Date("2026-01-01T00:00:00.000Z");
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const live: ArmLiveCodex = {
    executable: "/synthetic/codex",
    version: "codex-cli 1.0.0",
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
            availableCount: 2,
            detailsComplete: true,
            credits: [
              syntheticCredit("synthetic-a", nowSeconds + 3_600),
              syntheticCredit("synthetic-b", nowSeconds + 7_200),
            ],
          },
        }),
      close: () => Promise.resolve(),
    },
  };
  const dependencies: ArmDependencies = {
    paths,
    store,
    scheduler,
    connect: () => Promise.resolve(live),
    installRuntime: () =>
      Promise.resolve({
        version: "0.1.0",
        sha256: "a".repeat(64),
        directory: join(home, "runtime"),
        entrypoint: join(home, "runtime", "cli.js"),
      }),
    now: () => now,
    nodeExecutable: process.execPath,
    codexHome: join(home, ".codex"),
    home,
  };
  try {
    await assert.rejects(
      () =>
        armResets(
          { all: true, beforeSeconds: 600, dryRun: false },
          dependencies,
        ),
      /synthetic scheduler failure/u,
    );
    const state = await store.load();
    assert.ok(state);
    assert.deepEqual(
      state.plans.map((plan) => plan.status),
      ["paused", "paused"],
    );
    assert.deepEqual(
      new Set(removed),
      new Set(state.plans.map((plan) => plan.planId)),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function syntheticCredit(id: string, expiresAt: number) {
  return {
    id,
    resetType: "codexRateLimits" as const,
    status: "available" as const,
    grantedAt: expiresAt - 1_000,
    expiresAt,
    title: null,
    description: null,
  };
}
