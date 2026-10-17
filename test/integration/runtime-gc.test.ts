import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  armResets,
  type ArmDependencies,
} from "../../src/application/arm-service.js";
import { garbageCollect } from "../../src/application/plan-operations.js";
import { managedPaths } from "../../src/persistence/paths.js";
import {
  StateStore,
  type LockedState,
} from "../../src/persistence/state-store.js";
import {
  installRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../../src/runtime/installer.js";
import type { ExecSpec, SchedulerAdapter } from "../../src/scheduler/types.js";

const options = { all: false, beforeSeconds: 600, dryRun: false };

class ObservedStore extends StateStore {
  beforeLock: (() => void) | undefined;

  override withLock<T>(
    operation: (locked: LockedState) => Promise<T>,
    allowMissing = false,
  ): Promise<T> {
    this.beforeLock?.();
    return super.withLock(operation, allowMissing);
  }
}

test("GC waits for runtime publication and reloads the newly saved reference", async () => {
  const harness = await createHarness();
  const published = deferred<RuntimeSnapshot>();
  const resume = deferred<undefined>();
  const requested = deferred<undefined>();
  const collector = new ObservedStore(harness.dependencies.paths);
  collector.beforeLock = () => requested.resolve(undefined);
  const arming = armResets(options, {
    ...harness.dependencies,
    installRuntime: async (paths) => {
      const runtime = await installRuntimeSnapshot(paths, harness.source);
      published.resolve(runtime);
      await resume.promise;
      return runtime;
    },
  });
  let collection: Promise<unknown> | undefined;
  try {
    const runtime = await published.promise;
    assert.deepEqual((await harness.dependencies.store.load())?.plans, []);
    collection = garbageCollect(false, {
      ...harness.dependencies,
      store: collector,
    });
    // No sleeps: observe the lock request or the incorrect unlocked completion.
    const first = await Promise.race([
      requested.promise.then(() => "lock-requested"),
      collection.then(() => "collected"),
    ]);
    assert.equal(first, "lock-requested");
    await access(runtime.entrypoint);
    resume.resolve(undefined);
    const result = await arming;
    assert.equal(result.dryRun, false);
    assert.deepEqual(await collection, {
      dryRun: false,
      removedSchedulers: [],
      removedRuntimes: [],
    });
    assert.equal(
      (await harness.dependencies.store.load())?.plans[0]?.status,
      "armed",
    );
    assert.equal(harness.installed.length, 1);
    const entrypoint = harness.installed[0]?.arguments[0];
    assert.ok(entrypoint);
    await access(entrypoint);
  } finally {
    resume.resolve(undefined);
    await Promise.allSettled([
      arming,
      ...(collection === undefined ? [] : [collection]),
    ]);
    await harness.cleanup();
  }
});

test("GC owns the publication lock until deletion completes before rearming", async () => {
  const harness = await createHarness();
  const removalStarted = deferred<undefined>();
  const resume = deferred<undefined>();
  const requested = deferred<undefined>();
  let collection: Promise<unknown> | undefined;
  let arming: Promise<unknown> | undefined;
  try {
    await armResets(options, harness.dependencies);
    const initialPlan = (await harness.dependencies.store.load())?.plans[0];
    assert.ok(initialPlan);
    await harness.dependencies.store.withLock(async (locked) => {
      const state = locked.get();
      await locked.save({
        ...state,
        revision: state.revision + 1,
        plans: [{ ...initialPlan, status: "disarmed" }],
      });
    });
    collection = garbageCollect(false, {
      ...harness.dependencies,
      removeRuntime: async (directory) => {
        removalStarted.resolve(undefined);
        await resume.promise;
        await rm(directory, { recursive: true, force: true });
      },
    });
    await removalStarted.promise;
    const armer = new ObservedStore(harness.dependencies.paths);
    armer.beforeLock = () => requested.resolve(undefined);
    let installedWhileCollecting = false;
    arming = armResets(options, {
      ...harness.dependencies,
      store: armer,
      installRuntime: async (paths) => {
        installedWhileCollecting = true;
        return installRuntimeSnapshot(paths, harness.source);
      },
    });
    await requested.promise;
    assert.equal(installedWhileCollecting, false);
    resume.resolve(undefined);
    assert.deepEqual(await collection, {
      dryRun: false,
      removedSchedulers: [initialPlan.planId],
      removedRuntimes: [
        `${initialPlan.runtimeVersion}-${initialPlan.runtimeSha256}`,
      ],
    });
    await arming;
    assert.equal(harness.installed.length, 2);
    const entrypoint = harness.installed[1]?.arguments[0];
    assert.ok(entrypoint);
    await access(entrypoint);
  } finally {
    resume.resolve(undefined);
    await Promise.allSettled([
      ...(arming === undefined ? [] : [arming]),
      ...(collection === undefined ? [] : [collection]),
    ]);
    await harness.cleanup();
  }
});

test("native cleanup allows concurrent arm and GC reloads its reference", async () => {
  const harness = await createHarness();
  const removalStarted = deferred<undefined>();
  const resume = deferred<undefined>();
  let collection: Promise<unknown> | undefined;
  try {
    await armResets(options, harness.dependencies);
    const initialPlan = (await harness.dependencies.store.load())?.plans[0];
    assert.ok(initialPlan);
    await harness.dependencies.store.withLock(async (locked) => {
      const state = locked.get();
      await locked.save({
        ...state,
        revision: state.revision + 1,
        plans: [{ ...initialPlan, status: "disarmed" }],
      });
    });
    collection = garbageCollect(false, {
      ...harness.dependencies,
      scheduler: {
        ...harness.dependencies.scheduler,
        remove: async () => {
          removalStarted.resolve(undefined);
          await resume.promise;
        },
      },
    });
    await removalStarted.promise;
    // This completes while native removal is still paused: no write lock is held.
    await armResets(options, harness.dependencies);
    resume.resolve(undefined);
    assert.deepEqual(await collection, {
      dryRun: false,
      removedSchedulers: [initialPlan.planId],
      removedRuntimes: [],
    });
    const entrypoint = harness.installed[1]?.arguments[0];
    assert.ok(entrypoint);
    await access(entrypoint);
  } finally {
    resume.resolve(undefined);
    await Promise.allSettled(collection === undefined ? [] : [collection]);
    await harness.cleanup();
  }
});

test("failed publication releases the lock and GC can remove its unreferenced runtime", async () => {
  const harness = await createHarness();
  let runtime: RuntimeSnapshot | undefined;
  try {
    await assert.rejects(
      armResets(options, {
        ...harness.dependencies,
        installRuntime: async (paths) => {
          runtime = await installRuntimeSnapshot(paths, harness.source);
          throw new Error("synthetic publication failure");
        },
      }),
      /synthetic publication failure/u,
    );
    assert.ok(runtime);
    assert.deepEqual((await harness.dependencies.store.load())?.plans, []);
    assert.equal(harness.installed.length, 0);
    assert.deepEqual(await garbageCollect(false, harness.dependencies), {
      dryRun: false,
      removedSchedulers: [],
      removedRuntimes: [`${runtime.version}-${runtime.sha256}`],
    });
    await assert.rejects(access(runtime.entrypoint), { code: "ENOENT" });
  } finally {
    await harness.cleanup();
  }
});

test("GC dry-run does not acquire a write lock or mutate initialized or missing state", async () => {
  const harness = await createHarness();
  try {
    const before = await readdir(harness.home);
    assert.deepEqual(await garbageCollect(true, harness.dependencies), {
      dryRun: true,
      removedSchedulers: [],
      removedRuntimes: [],
    });
    assert.deepEqual(await readdir(harness.home), before);
    await harness.dependencies.store.initialize();
    const runtime = await installRuntimeSnapshot(
      harness.dependencies.paths,
      harness.source,
    );
    const stateBefore = await harness.dependencies.store.load();
    const observer = new ObservedStore(harness.dependencies.paths);
    observer.beforeLock = () => {
      throw new Error("dry-run tried to lock");
    };
    assert.deepEqual(
      await garbageCollect(true, { ...harness.dependencies, store: observer }),
      {
        dryRun: true,
        removedSchedulers: [],
        removedRuntimes: [`${runtime.version}-${runtime.sha256}`],
      },
    );
    assert.deepEqual(await observer.load(), stateBefore);
    await access(runtime.entrypoint);
  } finally {
    await harness.cleanup();
  }
});

for (const status of ["armed", "attempting", "settling", "paused"] as const) {
  test(`GC retains runtimes referenced by ${status} plans`, async () => {
    const harness = await createHarness();
    try {
      await armResets(options, harness.dependencies);
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
      assert.deepEqual(await garbageCollect(false, harness.dependencies), {
        dryRun: false,
        removedSchedulers: [],
        removedRuntimes: [],
      });
      const entrypoint = harness.installed[0]?.arguments[0];
      assert.ok(entrypoint);
      await access(entrypoint);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
