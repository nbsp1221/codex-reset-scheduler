import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ownedPlans,
  recordTree,
  removeRecordedTree,
  removeOwnedStateTree,
} from "./native-product-cleanup.mjs";

test("cleanup preserves a foreign file arriving after owned paths were recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "resetrail-cleanup-regression-"));
  try {
    await mkdir(join(root, "runtime"));
    await writeFile(join(root, "state.json"), "owned");
    await writeFile(join(root, "runtime", "cli.js"), "owned");
    const records = await recordTree(root);
    await writeFile(join(root, "foreign.txt"), "keep");
    const result = await removeRecordedTree(root, records);
    assert.equal(result.verified, false);
    assert.equal(await readFile(join(root, "foreign.txt"), "utf8"), "keep");
    assert.equal(await readFile(join(root, "state.json"), "utf8"), "owned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("cleanup rejects missing, empty and unrelated state plans", () => {
  for (const state of [
    {},
    { plans: [] },
    {
      plans: [
        { planId: "00000000-0000-4000-8000-000000000001", creditId: "other" },
      ],
    },
  ])
    assert.throws(() => ownedPlans(state, ["synthetic-owned"]));
});
test("cleanup removes only a fully recorded temporary tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "resetrail-cleanup-regression-"));
  await writeFile(join(root, "owned.txt"), "owned");
  assert.equal(
    (await removeRecordedTree(root, await recordTree(root))).verified,
    true,
  );
  await assert.rejects(readFile(join(root, "owned.txt")), { code: "ENOENT" });
});

test("cleanup preserves an unrecorded empty directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "resetrail-cleanup-regression-"));
  try {
    const records = await recordTree(root);
    await mkdir(join(root, "foreign"));
    assert.equal((await removeRecordedTree(root, records)).verified, false);
    assert.equal((await recordTree(root))[0].name, "foreign");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const lockProtocol = "codex-reset-scheduler state lock v2\n";
const stateRecords = [{ name: "state.json", kind: "file" }];

async function stateFixture(operation) {
  const root = await mkdtemp(join(tmpdir(), "resetrail-cleanup-lock-"));
  try {
    await writeFile(join(root, "state.json"), "owned");
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("state cleanup removes the exact v2 sentinel only after native tasks are absent", async () => {
  await stateFixture(async (root) => {
    await writeFile(join(root, ".lock"), lockProtocol);
    for (const nativeAbsent of [false, undefined]) {
      assert.equal(
        (await removeOwnedStateTree(root, stateRecords, { nativeAbsent }))
          .verified,
        false,
      );
      assert.equal(await readFile(join(root, ".lock"), "utf8"), lockProtocol);
      assert.equal(await readFile(join(root, "state.json"), "utf8"), "owned");
    }
    assert.equal(
      (await removeOwnedStateTree(root, stateRecords, { nativeAbsent: true }))
        .verified,
      true,
    );
    await assert.rejects(lstat(root), { code: "ENOENT" });
  });
});

test("state cleanup preserves unknown or nearly matching lock protocol contents", async () => {
  for (const contents of [
    "unknown lock",
    "",
    lockProtocol.trimEnd(),
    lockProtocol + "foreign content\n",
  ]) {
    await stateFixture(async (root) => {
      await writeFile(join(root, ".lock"), contents);
      assert.equal(
        (await removeOwnedStateTree(root, stateRecords, { nativeAbsent: true }))
          .verified,
        false,
      );
      assert.equal(await readFile(join(root, ".lock"), "utf8"), contents);
      assert.equal(await readFile(join(root, "state.json"), "utf8"), "owned");
    });
  }
});

test("state cleanup preserves a legacy lock directory and all owned state", async () => {
  await stateFixture(async (root) => {
    await mkdir(join(root, ".lock"));
    await writeFile(join(root, ".lock", "owner.json"), "preserve");
    assert.equal(
      (await removeOwnedStateTree(root, stateRecords, { nativeAbsent: true }))
        .verified,
      false,
    );
    assert.equal(
      await readFile(join(root, ".lock", "owner.json"), "utf8"),
      "preserve",
    );
    assert.equal(await readFile(join(root, "state.json"), "utf8"), "owned");
  });
});

test("state cleanup preserves a symlinked or junction protocol path", async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), "resetrail-cleanup-target-"));
  try {
    const target = join(targetRoot, "protocol");
    await writeFile(target, lockProtocol);
    await stateFixture(async (root) => {
      await symlink(
        process.platform === "win32" ? targetRoot : target,
        join(root, ".lock"),
        process.platform === "win32" ? "junction" : "file",
      );
      assert.equal(
        (await removeOwnedStateTree(root, stateRecords, { nativeAbsent: true }))
          .verified,
        false,
      );
      assert.equal((await lstat(join(root, ".lock"))).isSymbolicLink(), true);
      assert.equal(await readFile(target, "utf8"), lockProtocol);
      assert.equal(await readFile(join(root, "state.json"), "utf8"), "owned");
    });
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("state cleanup preserves an active v2 lock and its permanent sentinel", async () => {
  await stateFixture(async (root) => {
    await writeFile(join(root, ".lock"), lockProtocol);
    await mkdir(join(root, ".lock.v2"));
    const marker = `owner-v2.${process.pid}.00000000-0000-4000-8000-000000000001`;
    await writeFile(join(root, ".lock.v2", marker), "");
    assert.equal(
      (await removeOwnedStateTree(root, stateRecords, { nativeAbsent: true }))
        .verified,
      false,
    );
    assert.equal(await readFile(join(root, ".lock.v2", marker), "utf8"), "");
    assert.equal(await readFile(join(root, ".lock"), "utf8"), lockProtocol);
    assert.equal(await readFile(join(root, "state.json"), "utf8"), "owned");
  });
});
