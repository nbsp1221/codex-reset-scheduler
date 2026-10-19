import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  armResets,
  type ArmDependencies,
} from "../../src/application/arm-service.js";
import { disarmPlans } from "../../src/application/plan-operations.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { installRuntimeSnapshot } from "../../src/runtime/installer.js";
import type { ExecSpec, SchedulerAdapter } from "../../src/scheduler/types.js";
const options = { all: false, beforeSeconds: 600, dryRun: false };

test("successful installation does not wait for a concurrent worker state lock", async () => {
  const harness = await createHarness();
  const registered = new Set<string>();
  let acquiredResolve: () => void = () => undefined;
  const acquired = new Promise<void>((resolve) => {
    acquiredResolve = resolve;
  });
  let releaseResolve: () => void = () => undefined;
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  let worker: Promise<void> | undefined;
  const dependencies: ArmDependencies = {
    ...harness.dependencies,
    scheduler: {
      ...harness.dependencies.scheduler,
      install: async (plan) => {
        registered.add(plan.planId);
        // A real worker keeps this lock while awaiting backend IO. Hold it
        // until arm returns or rolls back, beyond the lock's acquisition budget.
        worker = dependencies.store.withLock(async () => {
          acquiredResolve();
          await release;
        });
        await acquired;
      },
      remove: (plan) => {
        registered.delete(plan.planId);
        releaseResolve();
        return Promise.resolve();
      },
    },
  };
  try {
    await armResets(options, dependencies);
    assert.equal(registered.size, 1);
    assert.equal((await dependencies.store.load())?.plans[0]?.status, "armed");
  } finally {
    releaseResolve();
    await worker;
    await harness.cleanup();
  }
});

for (const fail of [false, true]) {
  test(`arm ${fail ? "rollback" : "registration"} preserves a completed concurrent disarm`, async () => {
    const harness = await createHarness();
    const registered = new Set<string>();
    const dependencies: ArmDependencies = {
      ...harness.dependencies,
      scheduler: {
        ...harness.dependencies.scheduler,
        install: async (plan) => {
          await dependencies.store.withLock(() => Promise.resolve());
          await disarmPlans(
            { plan: plan.planId, all: false, dryRun: false },
            dependencies,
          );
          assert.equal(
            (await dependencies.store.load())?.plans[0]?.status,
            "disarmed",
          );
          registered.add(plan.planId);
          if (fail) throw new Error("synthetic install failure after disarm");
        },
        remove: async (plan) => {
          await dependencies.store.withLock(() => Promise.resolve());
          registered.delete(plan.planId);
        },
      },
    };
    try {
      await assert.rejects(
        armResets(options, dependencies),
        fail
          ? /synthetic install failure/
          : /changed during scheduler installation/,
      );
      assert.equal(
        (await dependencies.store.load())?.plans[0]?.status,
        "disarmed",
      );
      assert.equal(registered.size, 0);
    } finally {
      await harness.cleanup();
    }
  });
}
for (const status of [
  "succeeded",
  "expired",
  "unavailable",
  "paused",
  "attempting",
  "settling",
] as const) {
  test(`installation rollback preserves concurrent ${status} state`, async () => {
    const harness = await createHarness();
    const dependencies: ArmDependencies = {
      ...harness.dependencies,
      scheduler: {
        ...harness.dependencies.scheduler,
        install: async () => {
          await harness.dependencies.store.withLock(async (locked) => {
            const state = locked.get();
            await locked.save({
              ...state,
              revision: state.revision + 1,
              plans: state.plans.map((plan) => ({
                ...plan,
                status,
                attempt:
                  status === "attempting" || status === "settling"
                    ? {
                        idempotencyKey: "00000000-0000-4000-8000-000000000001",
                        startedAt: "2026-01-01T00:00:00.000Z",
                        lastTriedAt: "2026-01-01T00:00:00.000Z",
                        tryCount: 1,
                      }
                    : null,
              })),
            });
          });
          throw new Error("synthetic install failure after transition");
        },
      },
    };
    try {
      await assert.rejects(
        armResets(options, dependencies),
        /synthetic install failure/,
      );
      const persisted = (await dependencies.store.load())?.plans[0];
      assert.equal(persisted?.status, status);
      if (status === "attempting" || status === "settling") {
        assert.deepEqual(persisted.attempt, {
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
          startedAt: "2026-01-01T00:00:00.000Z",
          lastTriedAt: "2026-01-01T00:00:00.000Z",
          tryCount: 1,
        });
      }
    } finally {
      await harness.cleanup();
    }
  });
}
for (const status of [
  "succeeded",
  "expired",
  "unavailable",
  "paused",
] as const) {
  test(`successful installation tolerates concurrent ${status} without cancelling other plans`, async () => {
    const harness = await createHarness();
    const installed: string[] = [];
    const removed: string[] = [];
    const dependencies: ArmDependencies = {
      ...harness.dependencies,
      connect: async () => {
        const live = await harness.dependencies.connect();
        return {
          ...live,
          client: {
            ...live.client,
            readRateLimits: async () => {
              const snapshot = await live.client.readRateLimits();
              const credit = snapshot.resetCredits?.credits?.[0];
              assert.ok(credit);
              return {
                ...snapshot,
                resetCredits: {
                  availableCount: 2,
                  detailsComplete: true,
                  credits: [
                    credit,
                    { ...credit, id: "synthetic-second-credit" },
                  ],
                },
              };
            },
          },
        };
      },
      scheduler: {
        ...harness.dependencies.scheduler,
        install: async (plan) => {
          installed.push(plan.planId);
          if (installed.length !== 1) return;
          await dependencies.store.withLock(async (locked) => {
            const state = locked.get();
            await locked.save({
              ...state,
              revision: state.revision + 1,
              plans: state.plans.map((current) =>
                current.planId === plan.planId
                  ? {
                      ...current,
                      status,
                      terminalReason: "synthetic_worker_transition",
                    }
                  : current,
              ),
            });
          });
        },
        remove: (plan) => {
          removed.push(plan.planId);
          return Promise.resolve();
        },
      },
    };
    try {
      await armResets({ ...options, all: true }, dependencies);
      assert.equal(installed.length, 2);
      assert.equal(removed.length, 0);
      assert.deepEqual(
        (await dependencies.store.load())?.plans.map((plan) => plan.status),
        [status, "armed"],
      );
    } finally {
      await harness.cleanup();
    }
  });
}
async function createHarness() {
  const home = await mkdtemp(join(tmpdir(), "resetrail-runtime-gc-"));
  const source = join(home, "synthetic-source");
  await mkdir(source);
  await writeFile(join(source, "cli.js"), "// synthetic runtime only\n");
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const now = new Date("2026-01-01T00:00:00.000Z");
  const seconds = Math.floor(now.getTime() / 1_000);
  const installed: ExecSpec[] = [];
  const scheduler: SchedulerAdapter = {
    preview: (plan) => ({
      platform: "systemd",
      artifactId: plan.planId,
      files: [],
      registration: { executable: "synthetic", arguments: [] },
    }),
    install: (_plan, action) => {
      installed.push(action);
      return Promise.resolve(undefined);
    },
    inspect: () =>
      Promise.resolve({ installed: true, enabled: true, detail: "synthetic" }),
    remove: () => Promise.resolve(undefined),
  };
  const dependencies: ArmDependencies = {
    paths,
    store: new StateStore(paths),
    scheduler,
    installRuntime: (target) => installRuntimeSnapshot(target, source),
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
                    id: "synthetic-gc-credit",
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
          close: () => Promise.resolve(undefined),
        },
      }),
  };
  return {
    home,
    source,
    installed,
    dependencies,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
