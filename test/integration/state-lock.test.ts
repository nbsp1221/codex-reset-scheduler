import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { disarmPlans } from "../../src/application/plan-operations.js";
import { creditSelector } from "../../src/domain/policy.js";
import type { PlanStatus, ResetPlan } from "../../src/domain/types.js";
import type { SchedulerAdapter } from "../../src/scheduler/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";

const helper = fileURLToPath(
  new URL("../helpers/state-lock-child.js", import.meta.url),
);
type Message = { event: string; code?: string };

function launch(home: string, mode = "held") {
  const child = fork(helper, [home, mode], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: Message[] = [];
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (message: Message) => messages.push(message));
  async function wait(event: string): Promise<Message> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = messages.find((message) => message.event === event);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Child exited before ${event}: ${JSON.stringify(messages)} ${stderr}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Child did not reach ${event}: ${JSON.stringify(messages)} ${stderr}`,
    );
  }
  return { child, messages, wait, resume: () => child.send("continue") };
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "resetrail-lock-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  await store.initialize();
  return { home, paths, store, lockPath: `${paths.lockDirectory}.v2` };
}
async function deadPid(home: string): Promise<number> {
  const owner = launch(home);
  await owner.wait("entered");
  const pid = owner.child.pid;
  assert.ok(pid);
  await terminate(owner.child);
  return pid;
}

test("publishing a prepared lock never replaces a live nonempty lock", async () => {
  const f = await fixture();
  const owner = launch(f.home);
  try {
    await owner.wait("entered");
    const marker = await readdir(f.lockPath);
    const old = new Date("2000-01-01T00:00:00Z");
    await utimes(f.lockPath, old, old);
    await utimes(join(f.lockPath, marker[0] ?? "missing-marker"), old, old);
    let entered = false;
    await assert.rejects(
      () =>
        f.store.withLock(() => {
          entered = true;
          return Promise.resolve();
        }),
      { code: "state_locked" },
    );
    assert.equal(entered, false);
    assert.deepEqual(await readdir(f.lockPath), marker);
    assert.ok(await f.store.load());
    owner.resume();
    await owner.wait("released");
    await f.store.withLock(() => Promise.resolve());
  } finally {
    await terminate(owner.child);
    await rm(f.home, { recursive: true, force: true });
  }
});

for (const mode of ["before-marker", "after-marker", "held", "release-rmdir"]) {
  test(`process death at ${mode} cannot strand an active v2 lock`, async () => {
    const f = await fixture();
    const owner = launch(f.home, mode);
    try {
      if (mode === "held" || mode === "release-rmdir") {
        await owner.wait("entered");
        if (mode === "release-rmdir") {
          owner.resume();
          await owner.wait("before-rmdir");
          assert.deepEqual(await readdir(f.lockPath), []);
        }
      } else await owner.wait(mode);
      await terminate(owner.child);
      await f.store.withLock(async (locked) => {
        await locked.save({
          ...locked.get(),
          revision: locked.get().revision + 1,
        });
      });
      assert.equal((await f.store.load())?.revision, 1);
    } finally {
      await terminate(owner.child);
      await rm(f.home, { recursive: true, force: true });
    }
  });
}

test("failed marker writes leave no published lock and allow the next writer", async () => {
  const f = await fixture();
  const owner = launch(f.home, "write-fails");
  try {
    assert.equal((await owner.wait("failed")).code, "EIO");
    assert.equal(
      owner.messages.some((message) => message.event === "entered"),
      false,
    );
    assert.equal(
      (await readdir(f.paths.stateDirectory)).some((name) =>
        name.includes(".prepare-"),
      ),
      false,
    );
    await f.store.withLock(() => Promise.resolve());
  } finally {
    await terminate(owner.child);
    await rm(f.home, { recursive: true, force: true });
  }
});

for (const mode of ["reap-unlink", "reap-rmdir"]) {
  test(`a delayed ${mode} reaper cannot remove a successor's live lock`, async () => {
    const f = await fixture();
    await deadPid(f.home);
    const delayed = launch(f.home, mode);
    const successor = launch(f.home, "after-marker");
    try {
      await delayed.wait(
        mode === "reap-unlink" ? "before-stale-unlink" : "before-rmdir",
      );
      await successor.wait("after-marker");
      successor.resume();
      await successor.wait("entered");
      const marker = await readdir(f.lockPath);
      assert.ok(marker[0]?.startsWith(`owner-v2.${successor.child.pid}.`));
      delayed.resume();
      await delayed.wait(
        mode === "reap-unlink" ? "stale-unlink-missed" : "stale-rmdir-rejected",
      );
      assert.deepEqual(await readdir(f.lockPath), marker);
      assert.equal(
        delayed.messages.some((message) => message.event === "entered"),
        false,
      );
      successor.resume();
      await successor.wait("released");
      await delayed.wait("entered");
      delayed.resume();
      await delayed.wait("released");
    } finally {
      await terminate(delayed.child);
      await terminate(successor.child);
      await rm(f.home, { recursive: true, force: true });
    }
  });
}

test("marker identity permits dead-owner recovery even with damaged contents", async () => {
  const f = await fixture();
  try {
    await deadPid(f.home);
    const [marker] = await readdir(f.lockPath);
    assert.ok(marker);
    await writeFile(join(f.lockPath, marker), "{ damaged diagnostic contents");
    await f.store.withLock(() => Promise.resolve());
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

for (const mode of ["probe-eperm", "probe-unknown"]) {
  test(`${mode} cannot prove a lock owner dead`, async () => {
    const f = await fixture();
    const pid = await deadPid(f.home);
    const contender = launch(f.home, mode);
    try {
      const marker = await readdir(f.lockPath);
      assert.ok(marker[0]?.startsWith(`owner-v2.${pid}.`));
      assert.equal((await contender.wait("failed")).code, "state_locked");
      assert.deepEqual(await readdir(f.lockPath), marker);
    } finally {
      await terminate(contender.child);
      await rm(f.home, { recursive: true, force: true });
    }
  });
}

test("unknown v2 markers, extra entries and invalid PIDs require explicit recovery", async () => {
  const f = await fixture();
  try {
    for (const names of [
      ["owner.json"],
      [`owner-v2.9999999999.${randomUUID()}`],
      [`owner-v2.${process.pid}.${randomUUID()}`, "extra"],
    ]) {
      await mkdir(f.lockPath);
      for (const name of names) await writeFile(join(f.lockPath, name), "");
      await assert.rejects(() => f.store.withLock(() => Promise.resolve()), {
        code: "state_lock_recovery_required",
      });
      assert.deepEqual((await readdir(f.lockPath)).sort(), names.sort());
      await rm(f.lockPath, { recursive: true });
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("legacy empty, corrupt, dead and live locks are never automatically migrated", async () => {
  const f = await fixture();
  try {
    for (const contents of [
      null,
      "{",
      JSON.stringify({
        pid: 2147483647,
        createdAt: "2000-01-01",
        nonce: randomUUID(),
      }),
      JSON.stringify({
        pid: process.pid,
        createdAt: "2000-01-01",
        nonce: randomUUID(),
      }),
    ]) {
      await rm(f.paths.lockDirectory);
      await mkdir(f.paths.lockDirectory);
      if (contents !== null)
        await writeFile(join(f.paths.lockDirectory, "owner.json"), contents);
      await assert.rejects(() => f.store.withLock(() => Promise.resolve()), {
        code: "state_lock_recovery_required",
      });
      assert.deepEqual(
        await readdir(f.paths.lockDirectory),
        contents === null ? [] : ["owner.json"],
      );
      if (contents !== null)
        assert.equal(
          await readFile(join(f.paths.lockDirectory, "owner.json"), "utf8"),
          contents,
        );
      await rm(f.paths.lockDirectory, { recursive: true });
      await f.store.withLock(() => Promise.resolve());
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("the permanent protocol file prevents previous workers from acquiring a mkdir lock", async () => {
  const f = await fixture();
  try {
    const fence = await readFile(f.paths.lockDirectory, "utf8");
    await assert.rejects(() => mkdir(f.paths.lockDirectory), {
      code: "EEXIST",
    });
    await assert.rejects(() =>
      readFile(join(f.paths.lockDirectory, "owner.json")),
    );
    await f.store.withLock(() => Promise.resolve());
    assert.equal(await readFile(f.paths.lockDirectory, "utf8"), fence);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

for (const mode of ["before-protocol", "after-protocol"]) {
  test(`process death at ${mode} cannot publish an incomplete protocol fence`, async () => {
    const f = await fixture();
    await rm(f.paths.lockDirectory);
    const owner = launch(f.home, mode);
    try {
      await owner.wait(mode);
      await terminate(owner.child);
      await f.store.withLock(() => Promise.resolve());
      assert.equal(
        await readFile(f.paths.lockDirectory, "utf8"),
        "codex-reset-scheduler state lock v2\n",
      );
    } finally {
      await terminate(owner.child);
      await rm(f.home, { recursive: true, force: true });
    }
  });
}

test("simultaneous first writers share one complete protocol fence", async () => {
  const f = await fixture();
  await rm(f.paths.lockDirectory);
  const first = launch(f.home, "after-marker");
  const second = launch(f.home, "after-marker");
  try {
    await Promise.all([
      first.wait("after-marker"),
      second.wait("after-marker"),
    ]);
    first.resume();
    await first.wait("entered");
    second.resume();
    first.resume();
    await first.wait("released");
    await second.wait("entered");
    second.resume();
    await second.wait("released");
    assert.equal(
      await readFile(f.paths.lockDirectory, "utf8"),
      "codex-reset-scheduler state lock v2\n",
    );
  } finally {
    await terminate(first.child);
    await terminate(second.child);
    await rm(f.home, { recursive: true, force: true });
  }
});

test("unknown protocol files are preserved for explicit recovery", async () => {
  const f = await fixture();
  try {
    await rm(f.paths.lockDirectory);
    await writeFile(f.paths.lockDirectory, "unknown protocol");
    await assert.rejects(() => f.store.withLock(() => Promise.resolve()), {
      code: "state_lock_recovery_required",
    });
    assert.equal(
      await readFile(f.paths.lockDirectory, "utf8"),
      "unknown protocol",
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a symlinked or junction lock cannot redirect the writer or recovery", async () => {
  const f = await fixture();
  const target = join(f.home, "other-directory");
  try {
    await mkdir(target);
    await writeFile(join(target, "preserved"), "untouched");
    await symlink(
      target,
      f.lockPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(() => f.store.withLock(() => Promise.resolve()), {
      code: "unsafe_state_path",
    });
    assert.equal(
      await readFile(join(target, "preserved"), "utf8"),
      "untouched",
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("owner release during collision inspection retries instead of throwing the earlier rename error", async () => {
  const f = await fixture();
  const owner = launch(f.home);
  try {
    await owner.wait("entered");
    const recovering = launch(f.home, "release-on-owner-inspection");
    try {
      await recovering.wait("owner-observed");
      owner.resume();
      await owner.wait("released");
      await terminate(owner.child);
      recovering.resume();
      await recovering.wait("entered");
      assert.equal(
        recovering.messages.some((message) => message.event === "failed"),
        false,
      );
      recovering.resume();
      await recovering.wait("released");
    } finally {
      await terminate(recovering.child);
    }
  } finally {
    await terminate(owner.child);
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a definite rename collision with an already disappeared path retries within the wait budget", async () => {
  const f = await fixture();
  const contender = launch(f.home, "missing-collision");
  try {
    await contender.wait("entered");
    assert.equal(
      contender.messages.filter((message) => message.event === "rename-attempt")
        .length,
      2,
    );
    contender.resume();
    await contender.wait("released");
  } finally {
    await terminate(contender.child);
    await rm(f.home, { recursive: true, force: true });
  }
});

for (const mode of ["rename-io", "rename-denied", "rename-eperm"]) {
  for (const occupied of mode === "rename-eperm" ? [false] : [false, true]) {
    test(`${mode} propagates unchanged with ${occupied ? "an occupied" : "a missing"} lock path`, async () => {
      const f = await fixture();
      const owner = occupied ? launch(f.home) : null;
      let contender: ReturnType<typeof launch> | null = null;
      try {
        if (owner) await owner.wait("entered");
        const before = occupied ? await readdir(f.lockPath) : null;
        contender = launch(f.home, mode);
        const expected =
          mode === "rename-io"
            ? "EIO"
            : mode === "rename-denied"
              ? "EACCES"
              : "EPERM";
        assert.equal((await contender.wait("failed")).code, expected);
        assert.equal(
          contender.messages.filter(
            (message) => message.event === "rename-attempt",
          ).length,
          1,
        );
        assert.equal(
          contender.messages.some((message) => message.event === "entered"),
          false,
        );
        if (before) assert.deepEqual(await readdir(f.lockPath), before);
      } finally {
        if (owner) await terminate(owner.child);
        if (contender) await terminate(contender.child);
        await rm(f.home, { recursive: true, force: true });
      }
    });
  }
}

function migrationPlan(home: string, status: PlanStatus): ResetPlan {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    planId: randomUUID(),
    status,
    creditId: "synthetic-lock-migration-credit",
    creditSelector: creditSelector("synthetic-lock-migration-credit"),
    resetType: "codexRateLimits",
    grantedAt: 1_767_225_600,
    expiresAt: 1_767_235_600,
    notBefore: 1_767_225_600,
    accountFingerprint: "a".repeat(64),
    runtimeVersion: "0.1.0",
    runtimeSha256: "b".repeat(64),
    codexExecutable: join(home, "synthetic-codex"),
    codexVersionAtArm: "codex-cli synthetic",
    codexHome: join(home, "synthetic-codex-home"),
    attempt:
      status === "attempting" || status === "settling"
        ? {
            idempotencyKey: randomUUID(),
            startedAt: timestamp,
            lastTriedAt: timestamp,
            tryCount: 1,
          }
        : null,
    scheduler: {
      platform: "systemd",
      artifactId: "synthetic-migration-artifact",
      triggerTimesUtc: [timestamp],
    },
    terminalReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
async function persistMigrationPlan(
  f: Awaited<ReturnType<typeof fixture>>,
  status: PlanStatus,
): Promise<void> {
  await f.store.withLock(async (locked) => {
    const state = locked.get();
    await locked.save({
      ...state,
      revision: state.revision + 1,
      plans: [migrationPlan(f.home, status)],
    });
  });
}

for (const status of ["armed", "attempting", "settling", "paused"] as const) {
  test(`first v2 migration refuses an existing ${status} schedule without changing the fence, state, UUID or scheduler`, async () => {
    const f = await fixture();
    try {
      await persistMigrationPlan(f, status);
      await rm(f.paths.lockDirectory);
      const stateBefore = await readFile(f.paths.stateFile, "utf8");
      const entriesBefore = await readdir(f.paths.stateDirectory);
      let mutations = 0;
      const scheduler: SchedulerAdapter = {
        preview: () => {
          throw new Error("Unexpected scheduler preview");
        },
        inspect: () =>
          Promise.resolve({
            installed: true,
            enabled: true,
            detail: "synthetic",
          }),
        install: () => {
          mutations += 1;
          return Promise.resolve();
        },
        remove: () => {
          mutations += 1;
          return Promise.resolve();
        },
      };
      await assert.rejects(
        () =>
          disarmPlans(
            { all: true, dryRun: false },
            {
              paths: f.paths,
              store: f.store,
              scheduler,
              now: () => new Date("2026-01-01T00:00:00Z"),
            },
          ),
        (error: unknown) => {
          assert.equal(
            (error as { code: string }).code,
            "state_lock_migration_required",
          );
          assert.match(
            (error as Error).message,
            /previous version.*old writers stopped/,
          );
          return true;
        },
      );
      assert.equal(mutations, 0);
      assert.equal(await readFile(f.paths.stateFile, "utf8"), stateBefore);
      assert.deepEqual(await readdir(f.paths.stateDirectory), entriesBefore);
      await assert.rejects(() => readFile(f.paths.lockDirectory), {
        code: "ENOENT",
      });
      assert.ok(await f.store.load());
    } finally {
      await rm(f.home, { recursive: true, force: true });
    }
  });
}

test("the migration gate permits terminal-only legacy state and preserves it", async () => {
  const f = await fixture();
  try {
    for (const status of [
      "disarmed",
      "succeeded",
      "expired",
      "unavailable",
    ] as const) {
      await persistMigrationPlan(f, status);
      await rm(f.paths.lockDirectory);
      const stateBefore = await readFile(f.paths.stateFile, "utf8");
      await f.store.withLock(() => Promise.resolve());
      assert.equal(
        await readFile(f.paths.lockDirectory, "utf8"),
        "codex-reset-scheduler state lock v2\n",
      );
      assert.equal(await readFile(f.paths.stateFile, "utf8"), stateBefore);
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("an existing valid v2 fence permits its own active schedules", async () => {
  const f = await fixture();
  try {
    for (const status of [
      "armed",
      "attempting",
      "settling",
      "paused",
    ] as const) {
      await persistMigrationPlan(f, status);
      const stateBefore = await readFile(f.paths.stateFile, "utf8");
      await f.store.withLock(() => Promise.resolve());
      assert.equal(await readFile(f.paths.stateFile, "utf8"), stateBefore);
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("invalid legacy state cannot be treated as permission to publish a v2 fence", async () => {
  const f = await fixture();
  try {
    await rm(f.paths.lockDirectory);
    await writeFile(f.paths.stateFile, "{");
    const entriesBefore = await readdir(f.paths.stateDirectory);
    await assert.rejects(() => f.store.withLock(() => Promise.resolve()), {
      code: "protocol_error",
    });
    assert.deepEqual(await readdir(f.paths.stateDirectory), entriesBefore);
    assert.equal(await readFile(f.paths.stateFile, "utf8"), "{");
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
