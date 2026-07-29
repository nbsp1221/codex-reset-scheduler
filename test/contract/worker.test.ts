import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { accountFingerprint } from "../../src/codex/account.js";
import {
  runWorker,
  type WorkerClient,
  type WorkerDependencies,
} from "../../src/application/worker-service.js";
import type {
  ConsumeOutcome,
  RateLimitsSnapshot,
  ResetPlan,
} from "../../src/domain/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { creditSelector } from "../../src/domain/policy.js";
import { disarmPlans } from "../../src/application/plan-operations.js";
import type { SchedulerAdapter } from "../../src/scheduler/types.js";

const now = new Date("2026-01-01T02:38:20.000Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);

test("worker consumes only the exact target and succeeds after authoritative retirement", async () => {
  const harness = await createHarness();
  const calls: { creditId: string; key: string }[] = [];
  let reads = 0;
  const client = fakeClient({
    read: () => (reads++ === 0 ? snapshot(true) : snapshot(false)),
    consume: (creditId, key) => {
      calls.push({ creditId, key });
      return Promise.resolve("reset");
    },
  });
  try {
    const result = await runWorker(
      harness.plan.planId,
      harness.dependencies(client),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(calls.length, 1);
    const call = calls.at(0);
    assert.ok(call);
    assert.equal(call.creditId, "synthetic-target");
    assert.match(call.key, /^[0-9a-f-]{36}$/u);
    const state = await harness.store.load();
    assert.equal(state?.plans[0]?.status, "succeeded");
  } finally {
    await harness.cleanup();
  }
});

test("ambiguous failure persists and retries the same UUID", async () => {
  const harness = await createHarness();
  const firstKeys: string[] = [];
  const failing = fakeClient({
    read: () => snapshot(true),
    consume: (_creditId, key) => {
      firstKeys.push(key);
      return Promise.reject(new Error("synthetic transport loss"));
    },
  });
  try {
    await assert.rejects(
      () => runWorker(harness.plan.planId, harness.dependencies(failing)),
      /synthetic transport loss/,
    );
    const pending = await harness.store.load();
    assert.ok(pending);
    const pendingPlan = pending.plans[0];
    assert.ok(pendingPlan);
    assert.equal(pendingPlan.status, "attempting");
    const persistedKey = pendingPlan.attempt?.idempotencyKey;
    assert.equal(firstKeys[0], persistedKey);

    const retryKeys: string[] = [];
    const succeeding = fakeClient({
      read: () => snapshot(false),
      consume: (_creditId, key) => {
        retryKeys.push(key);
        return Promise.resolve("alreadyRedeemed");
      },
    });
    const result = await runWorker(
      harness.plan.planId,
      harness.dependencies(succeeding),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(retryKeys[0], persistedKey);
  } finally {
    await harness.cleanup();
  }
});

test("confirmed nothingToReset creates a fresh UUID on the next trigger", async () => {
  const harness = await createHarness();
  const keys: string[] = [];
  const client = fakeClient({
    read: () => snapshot(true),
    consume: (_creditId, key) => {
      keys.push(key);
      return Promise.resolve("nothingToReset");
    },
  });
  try {
    assert.equal(
      (await runWorker(harness.plan.planId, harness.dependencies(client)))
        .status,
      "armed",
    );
    assert.equal(
      (await runWorker(harness.plan.planId, harness.dependencies(client)))
        .status,
      "armed",
    );
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal((await harness.store.load())?.plans[0]?.attempt, null);
  } finally {
    await harness.cleanup();
  }
});

test("noCredit with the exact target still visible pauses on backend contradiction", async () => {
  const harness = await createHarness();
  let consumes = 0;
  const client = fakeClient({
    read: () => snapshot(true),
    consume: () => {
      consumes += 1;
      return Promise.resolve("noCredit");
    },
  });
  try {
    const result = await runWorker(
      harness.plan.planId,
      harness.dependencies(client),
    );
    assert.equal(result.status, "paused");
    assert.equal(consumes, 1);
    assert.equal(
      (await harness.store.load())?.plans[0]?.terminalReason,
      "backend_no_credit_contradiction",
    );
  } finally {
    await harness.cleanup();
  }
});

test("runtime and account mismatches fail closed before consume", async () => {
  const runtimeHarness = await createHarness();
  let runtimeConsumes = 0;
  const runtimeClient = fakeClient({
    read: () => snapshot(true),
    consume: () => {
      runtimeConsumes += 1;
      return Promise.resolve("reset");
    },
  });
  try {
    const dependencies = runtimeHarness.dependencies(runtimeClient);
    const result = await runWorker(runtimeHarness.plan.planId, {
      ...dependencies,
      runtimeHash: () => Promise.resolve("f".repeat(64)),
    });
    assert.equal(result.event, "runtime-mismatch");
    assert.equal(runtimeConsumes, 0);
  } finally {
    await runtimeHarness.cleanup();
  }

  const accountHarness = await createHarness();
  let accountConsumes = 0;
  const accountClient = fakeClient({
    account: {
      type: "chatgpt",
      email: "different@example.invalid",
      planType: "pro",
    },
    read: () => snapshot(true),
    consume: () => {
      accountConsumes += 1;
      return Promise.resolve("reset");
    },
  });
  try {
    const result = await runWorker(
      accountHarness.plan.planId,
      accountHarness.dependencies(accountClient),
    );
    assert.equal(result.event, "account-mismatch");
    assert.equal(accountConsumes, 0);
  } finally {
    await accountHarness.cleanup();
  }
});

test("scheduler platform mismatch pauses before connecting or consuming", async () => {
  const harness = await createHarness();
  let connects = 0;
  let consumes = 0;
  const client = fakeClient({
    read: () => snapshot(true),
    consume: () => {
      consumes += 1;
      return Promise.resolve("reset");
    },
  });
  try {
    const base = harness.dependencies(client);
    const result = await runWorker(harness.plan.planId, {
      ...base,
      paths: { ...base.paths, platform: "launchd" },
      connect: () => {
        connects += 1;
        return Promise.resolve(client);
      },
    });
    assert.equal(result.event, "scheduler-platform-mismatch");
    assert.equal(connects, 0);
    assert.equal(consumes, 0);
  } finally {
    await harness.cleanup();
  }
});

test("an expired armed plan never invokes consume", async () => {
  const harness = await createHarness();
  await replacePlan(harness.store, {
    ...harness.plan,
    expiresAt: nowSeconds,
  });
  let consumes = 0;
  const client = fakeClient({
    read: () => snapshot(true),
    consume: () => {
      consumes += 1;
      return Promise.resolve("reset");
    },
  });
  try {
    const result = await runWorker(
      harness.plan.planId,
      harness.dependencies(client),
    );
    assert.equal(result.status, "expired");
    assert.equal(consumes, 0);
  } finally {
    await harness.cleanup();
  }
});

test("worker rechecks the deadline immediately before consume", async () => {
  const harness = await createHarness();
  let consumes = 0;
  const client = fakeClient({
    read: () => snapshot(true),
    consume: () => {
      consumes += 1;
      return Promise.resolve("reset");
    },
  });
  const times = [
    now,
    new Date((harness.plan.expiresAt - 1) * 1_000),
    new Date(harness.plan.expiresAt * 1_000),
  ];
  let index = 0;
  try {
    const base = harness.dependencies(client);
    const result = await runWorker(harness.plan.planId, {
      ...base,
      now: () => times[Math.min(index++, times.length - 1)] ?? now,
    });
    assert.equal(result.event, "expired-before-consume");
    assert.equal(result.status, "expired");
    assert.equal(consumes, 0);
  } finally {
    await harness.cleanup();
  }
});

test("concurrent duplicate triggers serialize to one consume call", async () => {
  const harness = await createHarness();
  let reads = 0;
  let consumes = 0;
  let releaseConsume: (() => void) | undefined;
  const consumeGate = new Promise<void>((resolve) => {
    releaseConsume = resolve;
  });
  const client = fakeClient({
    read: () => (reads++ === 0 ? snapshot(true) : snapshot(false)),
    consume: async () => {
      consumes += 1;
      await consumeGate;
      return "reset";
    },
  });
  try {
    const dependencies = harness.dependencies(client);
    const first = runWorker(harness.plan.planId, dependencies);
    while (consumes === 0)
      await new Promise((resolve) => setImmediate(resolve));
    const second = runWorker(harness.plan.planId, dependencies);
    releaseConsume?.();
    const results = await Promise.all([first, second]);
    assert.equal(consumes, 1);
    assert.deepEqual(
      results.map((result) => result.status),
      ["succeeded", "succeeded"],
    );
  } finally {
    await harness.cleanup();
  }
});

test("disarm racing an ambiguous consume refuses removal", async () => {
  const harness = await createHarness();
  let consumeCalls = 0;
  let releaseConsume: (() => void) | undefined;
  const consumeGate = new Promise<void>((resolve) => {
    releaseConsume = resolve;
  });
  const client = fakeClient({
    read: () => snapshot(true),
    consume: async () => {
      consumeCalls += 1;
      await consumeGate;
      throw new Error("synthetic ambiguous transport loss");
    },
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
      Promise.resolve({ installed: true, enabled: true, detail: "registered" }),
    remove: (plan) => {
      removed.push(plan.planId);
      return Promise.resolve();
    },
  };
  try {
    const worker = runWorker(
      harness.plan.planId,
      harness.dependencies(client),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    while (consumeCalls === 0)
      await new Promise((resolve) => setImmediate(resolve));
    const base = harness.dependencies(client);
    const disarm = disarmPlans(
      { plan: harness.plan.planId, all: false, dryRun: false },
      {
        paths: base.paths,
        store: harness.store,
        scheduler,
        now: () => now,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    releaseConsume?.();
    assert.match(String(await worker), /ambiguous transport loss/u);
    assert.match(String(await disarm), /result may be ambiguous/u);
    assert.deepEqual(removed, []);
    assert.equal((await harness.store.load())?.plans[0]?.status, "attempting");
  } finally {
    await harness.cleanup();
  }
});

async function createHarness(): Promise<{
  plan: ResetPlan;
  store: StateStore;
  dependencies(client: WorkerClient): WorkerDependencies;
  cleanup(): Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "resetrail-worker-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  const initial = await store.initialize();
  const plan: ResetPlan = {
    planId: "00000000-0000-4000-8000-000000000010",
    status: "armed",
    creditId: "synthetic-target",
    creditSelector: creditSelector("synthetic-target"),
    resetType: "codexRateLimits",
    grantedAt: nowSeconds - 1_000,
    expiresAt: nowSeconds + 500,
    notBefore: nowSeconds - 100,
    accountFingerprint: accountFingerprint(
      { type: "chatgpt", email: "synthetic@example.invalid", planType: "pro" },
      initial.accountSalt,
    ),
    runtimeVersion: "0.1.0",
    runtimeSha256: "a".repeat(64),
    codexExecutable: "/synthetic/codex",
    codexVersionAtArm: "codex-cli 1.0.0",
    codexHome: join(home, ".codex"),
    attempt: null,
    scheduler: {
      platform: "systemd",
      artifactId: "00000000-0000-4000-8000-000000000010",
      triggerTimesUtc: [now.toISOString()],
    },
    terminalReason: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await store.withLock(async (locked) => {
    const state = locked.get();
    await locked.save({
      ...state,
      revision: state.revision + 1,
      plans: [plan],
    });
  });
  return {
    plan,
    store,
    dependencies: (client) => ({
      paths,
      store,
      connect: () => Promise.resolve(client),
      runtimeHash: () => Promise.resolve("a".repeat(64)),
      now: () => now,
    }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

function fakeClient(options: {
  account?: {
    type: "chatgpt";
    email: string | null;
    planType: string;
  };
  read: () => RateLimitsSnapshot;
  consume: (creditId: string, key: string) => Promise<ConsumeOutcome>;
}): WorkerClient {
  return {
    readAccount: () =>
      Promise.resolve(
        options.account ?? {
          type: "chatgpt",
          email: "synthetic@example.invalid",
          planType: "pro",
        },
      ),
    readRateLimits: () => Promise.resolve(options.read()),
    consumeExactCredit: options.consume,
    close: () => Promise.resolve(),
  };
}

async function replacePlan(store: StateStore, plan: ResetPlan): Promise<void> {
  await store.withLock(async (locked) => {
    const state = locked.get();
    await locked.save({
      ...state,
      revision: state.revision + 1,
      plans: [plan],
    });
  });
}

function snapshot(includeTarget: boolean): RateLimitsSnapshot {
  const protectedCredit = {
    id: "synthetic-protected",
    resetType: "codexRateLimits" as const,
    status: "available" as const,
    grantedAt: nowSeconds - 900,
    expiresAt: nowSeconds + 5_000,
    title: null,
    description: null,
  };
  const target = {
    id: "synthetic-target",
    resetType: "codexRateLimits" as const,
    status: "available" as const,
    grantedAt: nowSeconds - 1_000,
    expiresAt: nowSeconds + 500,
    title: null,
    description: null,
  };
  const credits = includeTarget ? [target, protectedCredit] : [protectedCredit];
  return {
    primary: {
      usedPercent: 75,
      windowDurationMins: 300,
      resetsAt: nowSeconds + 1_000,
    },
    secondary: null,
    resetCredits: {
      availableCount: credits.length,
      detailsComplete: true,
      credits,
    },
  };
}
