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
import {
  runWorker,
  type WorkerClient,
} from "../../src/application/worker-service.js";
import type {
  ChatgptAccount,
  RateLimitsSnapshot,
  ResetCredit,
  ResetPlan,
} from "../../src/domain/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";
import type { ExecSpec, SchedulerAdapter } from "../../src/scheduler/types.js";

test("arm through scheduled worker consumes only its bound synthetic credit", async () => {
  const home = await mkdtemp(join(tmpdir(), "resetrail-e2e-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  const now = new Date("2026-01-01T00:00:00.000Z");
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const account: ChatgptAccount = {
    type: "chatgpt",
    email: "synthetic@example.invalid",
    planType: "pro",
  };
  const target = credit("synthetic-target-e2e", nowSeconds + 3_600);
  const protectedCredit = credit("synthetic-protected-e2e", nowSeconds + 7_200);
  const protectedBefore = structuredClone(protectedCredit);
  let targetAvailable = true;
  let installedPlan: ResetPlan | undefined;
  let installedAction: ExecSpec | undefined;
  const scheduler: SchedulerAdapter = {
    preview: (plan) => ({
      platform: "systemd",
      artifactId: plan.planId,
      files: [],
      registration: { executable: "synthetic", arguments: [] },
    }),
    install: (plan, action) => {
      installedPlan = plan;
      installedAction = action;
      return Promise.resolve();
    },
    inspect: () =>
      Promise.resolve({ installed: true, enabled: true, detail: "registered" }),
    remove: () => Promise.resolve(),
  };
  const armLive: ArmLiveCodex = {
    executable: "/synthetic/codex",
    version: "codex-cli synthetic",
    client: {
      readAccount: () => Promise.resolve(account),
      readRateLimits: () => Promise.resolve(snapshot()),
      close: () => Promise.resolve(),
    },
  };
  const armDependencies: ArmDependencies = {
    paths,
    store,
    scheduler,
    connect: () => Promise.resolve(armLive),
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
  let consumeCalls = 0;
  const workerClient: WorkerClient = {
    readAccount: () => Promise.resolve(account),
    readRateLimits: () => Promise.resolve(snapshot()),
    consumeExactCredit: (creditId) => {
      consumeCalls += 1;
      assert.equal(creditId, target.id);
      targetAvailable = false;
      return Promise.resolve("reset");
    },
    close: () => Promise.resolve(),
  };

  function snapshot(): RateLimitsSnapshot {
    const credits = targetAvailable
      ? [structuredClone(target), structuredClone(protectedCredit)]
      : [structuredClone(protectedCredit)];
    return {
      primary: null,
      secondary: null,
      resetCredits: {
        availableCount: credits.length,
        detailsComplete: true,
        credits,
      },
    };
  }

  try {
    await armResets(
      { all: false, beforeSeconds: 600, dryRun: false },
      armDependencies,
    );
    assert.ok(installedPlan);
    assert.ok(installedAction);
    assert.doesNotMatch(
      JSON.stringify(installedAction),
      new RegExp(target.id, "u"),
    );
    assert.equal(installedAction.arguments.at(-1), installedPlan.planId);

    const result = await runWorker(installedPlan.planId, {
      paths,
      store,
      connect: () => Promise.resolve(workerClient),
      runtimeHash: () => Promise.resolve("a".repeat(64)),
      now: () => new Date(now.getTime() + 3_001_000),
    });
    assert.equal(result.status, "succeeded");
    assert.equal(consumeCalls, 1);
    assert.deepEqual(snapshot().resetCredits?.credits, [protectedBefore]);
    assert.equal((await store.load())?.plans[0]?.status, "succeeded");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function credit(id: string, expiresAt: number): ResetCredit {
  return {
    id,
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: expiresAt - 1_000,
    expiresAt,
    title: null,
    description: null,
  };
}
