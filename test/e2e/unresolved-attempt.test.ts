import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  armResets,
  type ArmDependencies,
} from "../../src/application/arm-service.js";
import { disarmPlans } from "../../src/application/plan-operations.js";
import {
  runWorker,
  type WorkerDependencies,
} from "../../src/application/worker-service.js";
import type {
  ChatgptAccount,
  ConsumeOutcome,
  RateLimitsSnapshot,
  ResetPlan,
} from "../../src/domain/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import type { SchedulerAdapter } from "../../src/scheduler/types.js";

const pauses = [
  ["account", "account_changed"],
  ["runtime", "runtime_hash_mismatch"],
  ["platform", "scheduler_platform_mismatch"],
] as const;

for (const [gate, reason] of pauses) {
  test(`ambiguous consume then ${gate} pause cannot discard or replace its UUID`, async () => {
    const harness = await createHarness();
    try {
      const id = await harness.arm();
      await assert.rejects(
        () => harness.worker(id),
        /synthetic transport loss/u,
      );
      const attempt = (await harness.plan()).attempt;
      assert.ok(attempt);

      assert.equal((await harness.worker(id, gate)).status, "paused");
      assert.equal((await harness.plan()).terminalReason, reason);
      assert.deepEqual((await harness.plan()).attempt, attempt);
      const paused = await harness.store.load();

      for (const all of [false, true]) {
        await assert.rejects(() => harness.disarm(id, all), {
          code: "attempt_in_flight",
        });
        assert.deepEqual(await harness.store.load(), paused);
        assert.deepEqual(harness.removed, []);
      }
      await assert.rejects(() => harness.arm(), { code: "already_armed" });
      assert.deepEqual(await harness.store.load(), paused);
      assert.equal(harness.installed.length, 1);

      // Restoring the safety gate must not infer a phase or send a fresh UUID.
      assert.equal((await harness.worker(id)).event, "terminal-noop");
      assert.deepEqual(harness.keys, [attempt.idempotencyKey]);
      assert.deepEqual((await harness.plan()).attempt, attempt);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${gate} pause before any attempt remains safely cancellable and rearmable`, async () => {
    const harness = await createHarness();
    try {
      const first = await harness.arm();
      assert.equal((await harness.worker(first, gate)).status, "paused");
      assert.equal((await harness.plan()).attempt, null);
      await harness.disarm(first);
      const next = await harness.arm();
      assert.notEqual(next, first);
      assert.equal(harness.installed.length, 2);
      assert.deepEqual(harness.keys, []);
    } finally {
      await harness.cleanup();
    }
  });
}

test("legacy terminal and disarmed records still reserve their retained attempt", async () => {
  const harness = await createHarness();
  try {
    const id = await harness.arm();
    await assert.rejects(() => harness.worker(id), /synthetic transport loss/u);
    const attempting = await harness.plan();
    for (const status of [
      "disarmed",
      "succeeded",
      "expired",
      "unavailable",
    ] as const) {
      await harness.replace({ ...attempting, status });
      const before = await harness.store.load();
      await assert.rejects(() => harness.arm(), { code: "already_armed" });
      assert.deepEqual(await harness.store.load(), before);
      assert.deepEqual((await harness.plan()).attempt, attempting.attempt);
    }
    assert.equal(harness.installed.length, 1);
    assert.equal(harness.keys.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("confirmed nothingToReset permits cancellation and a fresh plan attempt", async () => {
  const harness = await createHarness();
  try {
    const first = await harness.arm();
    harness.setOutcome("nothingToReset");
    assert.equal((await harness.worker(first)).status, "armed");
    assert.equal((await harness.plan()).attempt, null);
    await harness.disarm(first);
    const next = await harness.arm();
    assert.notEqual(next, first);
    assert.equal((await harness.worker(next)).status, "armed");
    assert.equal(harness.keys.length, 2);
    assert.notEqual(harness.keys[0], harness.keys[1]);
  } finally {
    await harness.cleanup();
  }
});

for (const outcome of ["reset", "alreadyRedeemed", "noCredit"] as const) {
  for (const targetRetired of [false, true]) {
    test(`${outcome} with retired=${targetRetired} permits cleanup without replacing its UUID`, async () => {
      const harness = await createHarness();
      try {
        const id = await harness.arm();
        harness.setOutcome(outcome, targetRetired);
        const result = await harness.worker(id);
        assert.equal(
          result.status,
          outcome === "noCredit"
            ? targetRetired
              ? "unavailable"
              : "paused"
            : targetRetired
              ? "succeeded"
              : "settling",
        );
        const attempt = (await harness.plan()).attempt;
        assert.ok(attempt);
        await harness.disarm(id);
        assert.equal((await harness.plan()).status, "disarmed");
        assert.deepEqual((await harness.plan()).attempt, attempt);
        assert.deepEqual(harness.removed, [id]);

        // Even a later stale snapshot cannot authorize a replacement attempt.
        harness.restoreTarget();
        await assert.rejects(() => harness.arm(), { code: "already_armed" });
        assert.deepEqual(harness.keys, [attempt.idempotencyKey]);
      } finally {
        await harness.cleanup();
      }
    });
  }
}

test("expiry after ambiguity remains unresolved and cannot discard the attempt identity", async () => {
  const harness = await createHarness();
  try {
    const id = await harness.arm();
    await assert.rejects(() => harness.worker(id), /synthetic transport loss/u);
    const attempt = (await harness.plan()).attempt;
    const result = await harness.worker(
      id,
      undefined,
      new Date("2026-01-01T00:05:00.000Z"),
    );
    assert.equal(result.status, "attempting");
    await assert.rejects(() => harness.disarm(id), {
      code: "attempt_in_flight",
    });
    assert.deepEqual((await harness.plan()).attempt, attempt);
    assert.deepEqual(harness.removed, []);
    // Harness clock returns to before expiry to model a later stale snapshot.
    await assert.rejects(() => harness.arm(), { code: "already_armed" });
    assert.equal(harness.keys.length, 1);
  } finally {
    await harness.cleanup();
  }
});

async function createHarness() {
  const home = await mkdtemp(join(tmpdir(), "resetrail-unresolved-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths, () => now);
  const now = new Date("2026-01-01T00:00:00.000Z");
  const seconds = Math.floor(now.getTime() / 1_000);
  const account: ChatgptAccount = {
    type: "chatgpt",
    email: "synthetic@example.invalid",
    planType: "pro",
  };
  const installed: string[] = [];
  const removed: string[] = [];
  const keys: string[] = [];
  let available = true;
  let outcome: ConsumeOutcome | undefined;
  let retire = false;
  const snapshot = (): RateLimitsSnapshot => ({
    primary: null,
    secondary: null,
    resetCredits: {
      availableCount: available ? 1 : 0,
      detailsComplete: true,
      credits: available
        ? [
            {
              id: "synthetic-unresolved",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: seconds - 1_000,
              expiresAt: seconds + 300,
              title: null,
              description: null,
            },
          ]
        : [],
    },
  });
  const scheduler: SchedulerAdapter = {
    preview: (plan) => ({
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
    remove: (plan) => {
      removed.push(plan.planId);
      return Promise.resolve();
    },
  };
  const dependencies: ArmDependencies = {
    paths,
    store,
    scheduler,
    home,
    now: () => now,
    nodeExecutable: process.execPath,
    codexHome: join(home, ".codex"),
    installRuntime: () =>
      Promise.resolve({
        version: "0.1.0",
        sha256: "a".repeat(64),
        directory: join(home, "runtime"),
        entrypoint: join(home, "runtime", "cli.js"),
      }),
    connect: () =>
      Promise.resolve({
        executable: "/synthetic/codex-never-executed",
        version: "synthetic",
        client: {
          readAccount: () => Promise.resolve(account),
          readRateLimits: () => Promise.resolve(snapshot()),
          close: () => Promise.resolve(),
        },
      }),
  };
  return {
    store,
    installed,
    removed,
    keys,
    arm: async () => {
      const result = await armResets(
        { all: false, beforeSeconds: 600, dryRun: false },
        dependencies,
      );
      const id = result.plans[0]?.planId;
      assert.ok(id);
      return id;
    },
    disarm: (id: string, all = false) =>
      disarmPlans(
        { ...(all ? {} : { plan: id }), all, dryRun: false },
        dependencies,
      ),
    worker: (
      id: string,
      gate?: "account" | "runtime" | "platform",
      time = now,
    ) => {
      const worker: WorkerDependencies = {
        paths: gate === "platform" ? { ...paths, platform: "launchd" } : paths,
        store,
        now: () => time,
        runtimeHash: () =>
          Promise.resolve((gate === "runtime" ? "b" : "a").repeat(64)),
        connect: () =>
          Promise.resolve({
            readAccount: () =>
              Promise.resolve(
                gate === "account"
                  ? { ...account, email: "synthetic-other@example.invalid" }
                  : account,
              ),
            readRateLimits: () => Promise.resolve(snapshot()),
            consumeExactCredit: (creditId, key) => {
              assert.equal(creditId, "synthetic-unresolved");
              keys.push(key);
              if (outcome === undefined)
                return Promise.reject(new Error("synthetic transport loss"));
              if (retire) available = false;
              return Promise.resolve(outcome);
            },
            close: () => Promise.resolve(),
          }),
      };
      return runWorker(id, worker);
    },
    plan: async () => {
      const plan = (await store.load())?.plans.at(-1);
      assert.ok(plan);
      return plan;
    },
    replace: (plan: ResetPlan) =>
      store.withLock(async (locked) => {
        const state = locked.get();
        await locked.save({
          ...state,
          revision: state.revision + 1,
          plans: [plan],
        });
      }),
    setOutcome: (next: ConsumeOutcome, retireTarget = false) => {
      outcome = next;
      retire = retireTarget;
    },
    restoreTarget: () => {
      available = true;
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
