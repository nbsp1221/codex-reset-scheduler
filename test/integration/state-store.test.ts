import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";

test("state store initializes private, valid, durable state", async () => {
  const home = await mkdtemp(join(tmpdir(), "resetrail-state-"));
  try {
    const paths = managedPaths({ platform: "linux", home, environment: {} });
    const store = new StateStore(paths);
    const state = await store.initialize();
    assert.equal(state.schemaVersion, 1);
    assert.ok(state.installId.length > 0);
    assert.equal((await lstat(paths.stateDirectory)).mode & 0o077, 0);
    assert.equal((await lstat(paths.stateFile)).mode & 0o077, 0);
    assert.doesNotMatch(
      await readFile(paths.stateFile, "utf8"),
      /token|email/i,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("state store rejects a symlinked state file", async () => {
  if (process.platform === "win32") return;
  const home = await mkdtemp(join(tmpdir(), "resetrail-state-"));
  try {
    const paths = managedPaths({ platform: "linux", home, environment: {} });
    const store = new StateStore(paths);
    await store.initialize();
    await rm(paths.stateFile);
    await symlink("/dev/null", paths.stateFile);
    await assert.rejects(() => store.load(), /symbolic link/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
