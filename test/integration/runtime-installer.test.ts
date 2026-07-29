import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { managedPaths } from "../../src/persistence/paths.js";
import {
  hashDirectory,
  installRuntimeSnapshot,
} from "../../src/runtime/installer.js";

test("runtime snapshot is a private content-addressed copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "resetrail-runtime-"));
  const source = join(home, "source");
  try {
    await mkdir(source);
    await writeFile(join(source, "cli.js"), "export {};\n");
    await writeFile(join(source, "worker.js"), "export {};\n");
    const paths = managedPaths({ platform: "linux", home, environment: {} });
    const snapshot = await installRuntimeSnapshot(paths, source);
    assert.equal(snapshot.sha256, await hashDirectory(snapshot.directory));
    assert.equal(await readFile(snapshot.entrypoint, "utf8"), "export {};\n");
    assert.doesNotMatch(snapshot.entrypoint, /source/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
