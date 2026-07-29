import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  disarmPlans,
  garbageCollect,
  planStatus,
  type OperationsDependencies,
} from "../../src/application/plan-operations.js";
import type { ResetPlan } from "../../src/domain/types.js";
import { creditSelector } from "../../src/domain/policy.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import type { SchedulerAdapter } from "../../src/scheduler/types.js";

test("status and dry-run disarm are read-only and sanitized", async () => {
  const harness = await createHarness("armed");
  try {
    const before = JSON.stringify(await harness.store.load());
    const status = JSON.stringify(
      await planStatus(undefined, harness.dependencies),
    );
    const preview = JSON.stringify(
      await disarmPlans(
        { plan: harness.plan.planId, all: false, dryRun: true },
        harness.dependencies,
      ),
    );
    assert.equal(JSON.stringify(await harness.store.load()), before);
    assert.doesNotMatch(status, /synthetic-private-credit/);
    assert.doesNotMatch(preview, /synthetic-private-credit/);
    assert.equal(harness.removed.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("disarm persists terminal state before removing the scheduler", async () => {
  const harness = await createHarness("armed");
  try {
    await disarmPlans(
      { plan: harness.plan.planId, all: false, dryRun: false },
      harness.dependencies,
    );
    assert.equal((await harness.store.load())?.plans[0]?.status, "disarmed");
    assert.deepEqual(harness.removed, [harness.plan.planId]);
  } finally {
    await harness.cleanup();
  }
});

test("garbage collection removes only terminal scheduler artifacts", async () => {
  const harness = await createHarness("succeeded");
  try {
    await garbageCollect(false, harness.dependencies);
    assert.deepEqual(harness.removed, [harness.plan.planId]);
  } finally {
    await harness.cleanup();
  }
});

test("status filters by exact plan ID or public selector", async () => {
  const harness = await createHarness("armed");
  try {
    const byId = (await planStatus(
      harness.plan.planId,
      harness.dependencies,
    )) as { plans: unknown[] };
    const bySelector = (await planStatus(
      harness.plan.creditSelector,
      harness.dependencies,
    )) as { plans: unknown[] };
    assert.equal(byId.plans.length, 1);
    assert.equal(bySelector.plans.length, 1);
    await assert.rejects(
      () => planStatus("missing", harness.dependencies),
      /not found or ambiguous/u,
    );
  } finally {
    await harness.cleanup();
  }
});

test("garbage collection retains active runtimes and removes only managed unreferenced snapshots", async () => {
  const harness = await createHarness("armed");
  try {
    const active = `${harness.plan.runtimeVersion}-${harness.plan.runtimeSha256}`;
    const stale = `0.0.9-${"d".repeat(64)}`;
    await mkdir(join(harness.dependencies.paths.runtimeDirectory, active), {
      recursive: true,
    });
    await mkdir(join(harness.dependencies.paths.runtimeDirectory, stale), {
      recursive: true,
    });
    await mkdir(
      join(harness.dependencies.paths.runtimeDirectory, "unexpected-folder"),
      { recursive: true },
    );
    await writeFile(
      join(harness.dependencies.paths.runtimeDirectory, stale, "cli.js"),
      "synthetic",
    );
    const preview = (await garbageCollect(true, harness.dependencies)) as {
      removedRuntimes: string[];
    };
    assert.deepEqual(preview.removedRuntimes, [stale]);
    const result = (await garbageCollect(false, harness.dependencies)) as {
      removedRuntimes: string[];
    };
    assert.deepEqual(result.removedRuntimes, [stale]);
    await assert.doesNotReject(() =>
      writeFile(
        join(harness.dependencies.paths.runtimeDirectory, active, "ok"),
        "x",
      ),
    );
    await assert.doesNotReject(() =>
      writeFile(
        join(
          harness.dependencies.paths.runtimeDirectory,
          "unexpected-folder",
          "ok",
        ),
        "x",
      ),
    );
  } finally {
    await harness.cleanup();
  }
});

async function createHarness(status: ResetPlan["status"]): Promise<{
  plan: ResetPlan;
  store: StateStore;
  dependencies: OperationsDependencies;
  removed: string[];
  cleanup(): Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "resetrail-operations-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  const initial = await store.initialize();
  const plan: ResetPlan = {
    planId: "00000000-0000-4000-8000-000000000020",
    status,
    creditId: "synthetic-private-credit",
    creditSelector: creditSelector("synthetic-private-credit"),
    resetType: "codexRateLimits",
    grantedAt: 1_000,
    expiresAt: 3_000,
    notBefore: 2_000,
    accountFingerprint: "b".repeat(64),
    runtimeVersion: "0.1.0",
    runtimeSha256: "c".repeat(64),
    codexExecutable: "/synthetic/codex",
    codexVersionAtArm: "synthetic",
    codexHome: join(home, ".codex"),
    attempt: null,
    scheduler: {
      platform: "systemd",
      artifactId: "resetrail-plan",
      triggerTimesUtc: ["2026-01-01T00:00:00.000Z"],
    },
    terminalReason: status === "succeeded" ? "target_retired" : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.withLock(async (locked) => {
    await locked.save({ ...initial, revision: 1, plans: [plan] });
  });
  const removed: string[] = [];
  const scheduler: SchedulerAdapter = {
    preview: () => ({
      platform: "systemd",
      artifactId: "synthetic",
      files: [],
      registration: { executable: "synthetic", arguments: [] },
    }),
    install: () => Promise.resolve(),
    inspect: () =>
      Promise.resolve({ installed: true, enabled: true, detail: "sanitized" }),
    remove: (target) => {
      removed.push(target.planId);
      return Promise.resolve();
    },
  };
  return {
    plan,
    store,
    removed,
    dependencies: {
      paths,
      store,
      scheduler,
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
