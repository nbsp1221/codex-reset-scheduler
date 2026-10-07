import assert from "node:assert/strict";
import { lstat, readdir, readlink, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";

// A recorded path is not a claim to future files added beneath that directory.
export async function recordTree(root) {
  const records = [];
  async function visit(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      const file = join(root, name);
      if (entry.isDirectory()) {
        records.push({ name, kind: "directory" });
        await visit(file, name);
      } else
        records.push({
          name,
          kind: entry.isSymbolicLink() ? "symlink" : "file",
          ...(entry.isSymbolicLink() ? { target: await readlink(file) } : {}),
        });
    }
  }
  const metadata = await lstat(root);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  await visit(root);
  return records;
}
export function ownedPlans(state, expectedCredits) {
  assert.ok(
    Array.isArray(state.plans) && state.plans.length > 0,
    "nonempty owned plans required",
  );
  const ids = new Set();
  for (const p of state.plans) {
    assert.ok(
      expectedCredits.includes(p.creditId) &&
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(p.planId) &&
        !ids.has(p.planId),
      "unrelated plan preserved",
    );
    ids.add(p.planId);
  }
  return state.plans;
}
export async function removeRecordedTree(root, records) {
  const current = await recordTree(root);
  const allowed = new Map(records.map((r) => [r.name, r]));
  for (const r of current) {
    const known = allowed.get(r.name);
    if (!known || known.kind !== r.kind || known.target !== r.target)
      return { verified: false, reason: "unrecorded_content_preserved" };
  }
  // Never recursively remove a directory. A late-arriving file survives rmdir.
  for (const r of current.filter((r) => r.kind !== "directory"))
    await unlink(join(root, r.name));
  async function empty(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("late_content_preserved");
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (allowed.get(name)?.kind !== "directory")
        throw new Error("late_content_preserved");
      await empty(join(directory, entry.name), name);
    }
    await rmdir(directory);
  }
  try {
    await empty(root);
    return { verified: true };
  } catch (error) {
    return {
      verified: false,
      reason:
        error.code === "ENOTEMPTY" ? "late_content_preserved" : error.message,
    };
  }
}
