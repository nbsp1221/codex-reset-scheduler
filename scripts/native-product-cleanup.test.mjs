import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ownedPlans,
  recordTree,
  removeRecordedTree,
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
