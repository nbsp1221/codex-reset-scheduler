import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";

for (const mode of [
  "release-success",
  "release-primary-error",
  "acquire-transient",
  "acquire-persistent",
  "release-already-removed",
  "release-successor",
  "release-unsafe",
  "release-nonwindows",
]) {
  test(`Windows rmdir EPERM: ${mode}`, async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "synthetic-lock-eperm-"));
    const paths = managedPaths({ platform: "linux", home, environment: {} });
    const store = new StateStore(paths);
    const lock = `${paths.lockDirectory}.v2`;
    const successor = `owner-v2.${process.pid}.11111111-1111-4111-8111-111111111111`;
    const original = { rmdir: fs.rmdir, rename: fs.rename };
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    let faults = 0;
    let entered = false;
    try {
      await store.initialize();
      if (mode.startsWith("acquire")) await fs.mkdir(lock);
      Object.defineProperty(process, "platform", {
        ...platform,
        value: mode === "release-nonwindows" ? "linux" : "win32",
      });
      fs.rename = async (from, to) => {
        if (to === lock && mode.startsWith("acquire")) {
          try {
            await fs.lstat(lock);
            throw Object.assign(new Error("Synthetic directory collision"), {
              code: "EEXIST",
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return original.rename(from, to);
      };
      fs.rmdir = async (...args: Parameters<typeof fs.rmdir>) => {
        if (
          args[0] === lock &&
          (faults === 0 || mode === "acquire-persistent")
        ) {
          faults += 1;
          if (mode === "release-already-removed") await original.rmdir(lock);
          if (mode === "release-successor")
            await fs.writeFile(join(lock, successor), "");
          if (mode === "release-unsafe") {
            await original.rmdir(lock);
            await fs.writeFile(lock, "Synthetic unexpected replacement");
          }
          throw Object.assign(new Error("Synthetic rmdir denial"), {
            code: "EPERM",
          });
        }
        return original.rmdir(...args);
      };
      syncBuiltinESMExports();
      const operation = store.withLock(async () => {
        entered = true;
        if (mode === "release-primary-error")
          throw new Error("result may be ambiguous");
        return Promise.resolve("ok");
      });
      if (mode === "release-nonwindows") {
        await assert.rejects(operation, { code: "EPERM" });
        assert.equal(entered, true);
        assert.equal(faults, 1);
        assert.deepEqual(await fs.readdir(lock), []);
      } else if (mode === "acquire-persistent") {
        await assert.rejects(operation, { code: "EPERM" });
        assert.equal(entered, false);
        assert.equal(faults, 5);
        assert.deepEqual(await fs.readdir(lock), []);
      } else if (mode === "release-unsafe") {
        await assert.rejects(operation, {
          code: "state_lock_recovery_required",
        });
        assert.equal(entered, true);
        assert.equal(faults, 1);
        assert.equal(
          await fs.readFile(lock, "utf8"),
          "Synthetic unexpected replacement",
        );
      } else {
        if (mode === "release-primary-error")
          await assert.rejects(operation, /result may be ambiguous/u);
        else assert.equal(await operation, "ok");
        assert.equal(entered, true);
        assert.equal(faults, 1);
        if (mode === "release-successor")
          assert.deepEqual(await fs.readdir(lock), [successor]);
        else await assert.rejects(fs.lstat(lock), { code: "ENOENT" });
      }
    } finally {
      fs.rmdir = original.rmdir;
      fs.rename = original.rename;
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
}
