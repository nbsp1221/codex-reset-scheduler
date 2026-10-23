import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { armResets } from "../../src/application/arm-service.js";
import { planStatus } from "../../src/application/plan-operations.js";
import {
  runWorker,
  type WorkerClient,
} from "../../src/application/worker-service.js";
import { accountFingerprint } from "../../src/codex/account.js";
import { decodeInstallState } from "../../src/domain/state-schema.js";
import { creditSelector } from "../../src/domain/policy.js";
import type { ConsumeOutcome, ResetPlan } from "../../src/domain/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import type { SchedulerAdapter } from "../../src/scheduler/types.js";

const start = Date.parse("2026-01-01T00:00:00Z");
const account = {
  type: "chatgpt" as const,
  email: "synthetic@example.invalid",
  planType: "pro",
};

async function fixture(onConsume?: () => ConsumeOutcome) {
  const home = await mkdtemp(join(tmpdir(), "resetrail-expiry-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  const initial = await store.initialize();
  const plan: ResetPlan = {
    planId: "00000000-0000-4000-8000-000000000090",
    creditId: "synthetic-expiry-credit",
    creditSelector: creditSelector("synthetic-expiry-credit"),
    resetType: "codexRateLimits",
    status: "armed",
    grantedAt: start / 1000 - 1000,
    notBefore: start / 1000,
    expiresAt: start / 1000 + 120,
    accountFingerprint: accountFingerprint(account, initial.accountSalt),
    runtimeVersion: "0.1.0",
    runtimeSha256: "a".repeat(64),
    codexExecutable: "/synthetic/codex",
    codexVersionAtArm: "synthetic",
    codexHome: join(home, "codex"),
    attempt: null,
    scheduler: {
      platform: "systemd",
      artifactId: "synthetic-expiry",
      triggerTimesUtc: [new Date(start + 60000).toISOString()],
    },
    terminalReason: null,
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
  };
  await store.withLock(async (locked) => {
    await locked.save({ ...initial, revision: 1, plans: [plan] });
  });
  const scheduler: SchedulerAdapter = {
    preview: () => {
      throw new Error("Unexpected scheduler preview");
    },
    install: () => {
      throw new Error("Unexpected scheduler installation");
    },
    remove: () => {
      throw new Error("Unexpected scheduler removal");
    },
    inspect: () =>
      Promise.resolve({
        installed: true,
        enabled: true,
        detail: "elapsed fixture",
      }),
  };
  let connections = 0;
  let consumes = 0;
  const client: WorkerClient = {
    readAccount: () => Promise.resolve(account),
    readRateLimits: () =>
      Promise.resolve({
        primary: null,
        secondary: null,
        resetCredits: {
          availableCount: 1,
          detailsComplete: true,
          credits: [
            {
              id: plan.creditId,
              resetType: plan.resetType,
              status: "available",
              grantedAt: plan.grantedAt,
              expiresAt: plan.expiresAt,
              title: null,
              description: null,
            },
          ],
        },
      }),
    consumeExactCredit: () => {
      consumes += 1;
      return Promise.resolve(onConsume?.() ?? "nothingToReset");
    },
    close: () => Promise.resolve(),
  };
  return {
    home,
    paths,
    store,
    plan,
    operations: { paths, store, scheduler, now: () => new Date() },
    worker: {
      paths,
      store,
      connect: () => {
        connections += 1;
        return Promise.resolve(client);
      },
      runtimeHash: () => Promise.resolve(plan.runtimeSha256),
      now: () => new Date(),
    },
    counts: () => ({ connections, consumes }),
    replace: async (replacement: ResetPlan) => {
      await store.withLock(async (locked) => {
        const state = locked.get();
        await locked.save({
          ...state,
          revision: state.revision + 1,
          plans: [replacement],
        });
      });
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("last nothingToReset expires without another invocation; reads stay read-only", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start + 60000 });
  const f = await fixture();
  try {
    assert.equal((await runWorker(f.plan.planId, f.worker)).status, "armed");
    const before = await readFile(f.paths.stateFile, "utf8");
    assert.equal(
      decodeInstallState(JSON.parse(before) as unknown).plans[0]?.attempt,
      null,
    );
    t.mock.timers.setTime(start + 119999);
    assert.equal((await f.store.load())?.plans[0]?.status, "armed");
    t.mock.timers.setTime(start + 120000);
    const view = (await planStatus(undefined, f.operations)) as {
      plans: ResetPlan[];
    };
    assert.equal(view.plans[0]?.status, "expired");
    assert.equal(view.plans[0].terminalReason, "deadline_passed");
    assert.equal(await readFile(f.paths.stateFile, "utf8"), before);
    assert.deepEqual(f.counts(), { connections: 1, consumes: 1 });
    await f.store.withLock((locked) => {
      assert.equal(locked.get().plans[0]?.status, "expired");
      return Promise.resolve();
    });
    const persisted = decodeInstallState(
      JSON.parse(await readFile(f.paths.stateFile, "utf8")) as unknown,
    );
    assert.equal(persisted.plans[0]?.status, "expired");
    assert.equal(
      persisted.revision,
      decodeInstallState(JSON.parse(before) as unknown).revision + 1,
    );
    assert.deepEqual(f.counts(), { connections: 1, consumes: 1 });
  } finally {
    await f.cleanup();
  }
});

test("the last valid send can finish with nothingToReset at expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start + 119999 });
  const f = await fixture(() => {
    t.mock.timers.setTime(start + 120000);
    return "nothingToReset";
  });
  try {
    assert.equal((await runWorker(f.plan.planId, f.worker)).status, "expired");
    const persisted = decodeInstallState(
      JSON.parse(await readFile(f.paths.stateFile, "utf8")) as unknown,
    ).plans[0];
    assert.equal(persisted?.status, "expired");
    assert.equal(persisted.attempt, null);
    assert.equal(persisted.terminalReason, "deadline_passed");
    assert.deepEqual(f.counts(), { connections: 1, consumes: 1 });
  } finally {
    await f.cleanup();
  }
});

test("expiry preserves unresolved attempts and existing terminal outcomes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await fixture();
  try {
    const attempt = {
      idempotencyKey: "00000000-0000-4000-8000-000000000091",
      startedAt: new Date(start).toISOString(),
      lastTriedAt: new Date(start).toISOString(),
      tryCount: 1,
    };
    for (const status of [
      "armed",
      "attempting",
      "settling",
      "paused",
      "succeeded",
      "disarmed",
    ] as const) {
      t.mock.timers.setTime(start);
      const plan = { ...f.plan, status, attempt };
      await f.replace(plan);
      const before = await readFile(f.paths.stateFile, "utf8");
      t.mock.timers.setTime(start + 121000);
      const view = (await f.store.load())?.plans[0];
      assert.equal(view?.status, status);
      assert.deepEqual(view.attempt, attempt);
      assert.equal(await readFile(f.paths.stateFile, "utf8"), before);
    }
    assert.deepEqual(f.counts(), { connections: 0, consumes: 0 });
  } finally {
    await f.cleanup();
  }
});

test("an expired unresolved worker does not consume or infer success from credit disappearance", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await fixture();
  try {
    const attempt = {
      idempotencyKey: "00000000-0000-4000-8000-000000000092",
      startedAt: new Date(start).toISOString(),
      lastTriedAt: new Date(start).toISOString(),
      tryCount: 1,
    };
    for (const status of ["armed", "attempting"] as const) {
      t.mock.timers.setTime(start);
      await f.replace({ ...f.plan, status, attempt });
      t.mock.timers.setTime(start + 121000);
      await runWorker(f.plan.planId, f.worker);
      const after = (await f.store.load())?.plans[0];
      assert.equal(after?.status, status);
      assert.deepEqual(after.attempt, attempt);
    }
    assert.deepEqual(f.counts(), { connections: 0, consumes: 0 });
  } finally {
    await f.cleanup();
  }
});

test("a new booking checkpoints legacy expiry through the normal lock transition", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await fixture();
  try {
    await rm(f.paths.lockDirectory);
    const before = await readFile(f.paths.stateFile, "utf8");
    t.mock.timers.setTime(start + 121000);
    assert.equal((await f.store.load())?.plans[0]?.status, "expired");
    await assert.rejects(readFile(f.paths.lockDirectory), { code: "ENOENT" });
    assert.equal(await readFile(f.paths.stateFile, "utf8"), before);
    let installed = 0;
    const futureCredit = {
      id: "synthetic-future-credit",
      resetType: "codexRateLimits" as const,
      status: "available" as const,
      grantedAt: start / 1000,
      expiresAt: start / 1000 + 3600,
      title: null,
      description: null,
    };
    await armResets(
      { all: true, beforeSeconds: 600, dryRun: false },
      {
        ...f.operations,
        scheduler: {
          ...f.operations.scheduler,
          preview: (plan) => ({
            platform: "systemd",
            artifactId: plan.planId,
            files: [],
            registration: { executable: "synthetic", arguments: [] },
          }),
          install: () => {
            installed += 1;
            return Promise.resolve();
          },
        },
        connect: () =>
          Promise.resolve({
            executable: "/synthetic/codex",
            version: "synthetic",
            client: {
              readAccount: () => Promise.resolve(account),
              readRateLimits: () =>
                Promise.resolve({
                  primary: null,
                  secondary: null,
                  resetCredits: {
                    availableCount: 1,
                    detailsComplete: true,
                    credits: [futureCredit],
                  },
                }),
              close: () => Promise.resolve(),
            },
          }),
        installRuntime: () =>
          Promise.resolve({
            version: "0.1.0",
            sha256: "b".repeat(64),
            directory: join(f.home, "runtime"),
            entrypoint: join(f.home, "runtime", "cli.js"),
          }),
        nodeExecutable: process.execPath,
        codexHome: join(f.home, "codex"),
        home: f.home,
      },
    );
    const persisted = decodeInstallState(
      JSON.parse(await readFile(f.paths.stateFile, "utf8")) as unknown,
    );
    assert.equal(persisted.plans[0]?.status, "expired");
    assert.equal(persisted.plans[1]?.status, "armed");
    assert.equal(persisted.plans[1].creditId, futureCredit.id);
    assert.equal(installed, 1);
    assert.deepEqual(f.counts(), { connections: 0, consumes: 0 });
  } finally {
    await f.cleanup();
  }
});
