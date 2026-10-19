import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";

for (const mode of [
  "missing-transient",
  "owner-disappears",
  "missing-persistent",
  "successor-during-backoff",
  "existing-live",
  "unsafe-file",
  "unsafe-symlink",
  "inspection-denied",
  "nonwindows",
]) {
  test(`Windows rename EPERM: ${mode}`, async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "synthetic-rename-eperm-"));
    const paths = managedPaths({ platform: "linux", home, environment: {} });
    const store = new StateStore(paths);
    const lock = `${paths.lockDirectory}.v2`;
    const marker = `owner-v2.${process.pid}.22222222-2222-4222-8222-222222222222`;
    const target = join(home, "preserved-target");
    const original = {
      rename: fs.rename,
      lstat: fs.lstat,
      unlink: fs.unlink,
      rmdir: fs.rmdir,
      readdir: fs.readdir,
    };
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    const nativePlatform = process.platform;
    let renameCalls = 0;
    let recoveryReads = 0;
    let entered = false;
    let ownerReleased = false;
    const denial = Object.assign(new Error("Synthetic rename denial"), {
      code: "EPERM",
    });
    const inspectionDenial = Object.assign(
      new Error("Synthetic inspection denial"),
      { code: "EACCES" },
    );
    async function publishOwner() {
      await fs.mkdir(lock);
      await fs.writeFile(join(lock, marker), "");
    }
    async function releaseOwner() {
      assert.deepEqual(await original.readdir(lock), [marker]);
      await original.unlink(join(lock, marker));
      await original.rmdir(lock);
      ownerReleased = true;
    }
    try {
      await store.initialize();
      await fs.mkdir(target);
      await fs.writeFile(join(target, "preserved"), "untouched");
      if (mode === "owner-disappears" || mode === "existing-live")
        await publishOwner();
      Object.defineProperty(process, "platform", {
        ...platform,
        value: mode === "nonwindows" ? "linux" : "win32",
      });
      fs.unlink = async (...args) => {
        if (
          String(args[0]).startsWith(`${lock}/`) ||
          String(args[0]).startsWith(`${lock}\\`)
        )
          assert.equal(entered, true, "must not unlink an unproven owner");
        return original.unlink(...args);
      };
      fs.rmdir = async (...args) => {
        if (args[0] === lock)
          assert.equal(
            entered,
            true,
            "must not remove a lock based on absent-target EPERM",
          );
        return original.rmdir(...args);
      };
      fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
        if (args[0] === lock && !entered) recoveryReads += 1;
        return original.readdir(...args);
      }) as typeof fs.readdir;
      fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === lock && renameCalls > 0 && mode === "inspection-denied")
          throw inspectionDenial;
        try {
          return await original.lstat(...args);
        } catch (error) {
          if (
            args[0] === lock &&
            renameCalls === 1 &&
            mode === "successor-during-backoff" &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
            await publishOwner();
          throw error;
        }
      }) as typeof fs.lstat;
      fs.rename = async (from, to) => {
        if (to !== lock) return original.rename(from, to);
        renameCalls += 1;
        if (mode === "missing-persistent") throw denial;
        if (renameCalls === 1) {
          if (mode === "owner-disappears") await releaseOwner();
          if (mode === "unsafe-file")
            await fs.writeFile(lock, "preserved-file");
          if (mode === "unsafe-symlink")
            await fs.symlink(
              target,
              lock,
              nativePlatform === "win32" ? "junction" : "dir",
            );
          throw denial;
        }
        if (mode === "successor-during-backoff" && renameCalls === 2) {
          assert.deepEqual(await original.readdir(lock), [marker]);
          throw denial;
        }
        if (mode === "existing-live" || mode === "successor-during-backoff")
          await releaseOwner();
        return original.rename(from, to);
      };
      syncBuiltinESMExports();
      const operation = store.withLock(() => {
        entered = true;
        if (
          [
            "owner-disappears",
            "existing-live",
            "successor-during-backoff",
          ].includes(mode)
        )
          assert.equal(ownerReleased, true);
        return Promise.resolve("ok");
      });
      if (
        [
          "missing-persistent",
          "unsafe-file",
          "unsafe-symlink",
          "inspection-denied",
          "nonwindows",
        ].includes(mode)
      ) {
        await assert.rejects(
          operation,
          (error) =>
            error ===
            (mode === "inspection-denied" ? inspectionDenial : denial),
        );
        assert.equal(entered, false);
        assert.equal(renameCalls, mode === "missing-persistent" ? 5 : 1);
        assert.equal(recoveryReads, 0);
        if (mode === "unsafe-file")
          assert.equal(await fs.readFile(lock, "utf8"), "preserved-file");
        if (mode === "unsafe-symlink")
          assert.equal((await original.lstat(lock)).isSymbolicLink(), true);
      } else {
        assert.equal(await operation, "ok");
        assert.equal(entered, true);
        assert.equal(renameCalls, mode === "successor-during-backoff" ? 3 : 2);
        assert.equal(
          recoveryReads,
          ["existing-live", "successor-during-backoff"].includes(mode) ? 1 : 0,
        );
        await assert.rejects(original.lstat(lock), { code: "ENOENT" });
      }
      assert.equal(
        await fs.readFile(join(target, "preserved"), "utf8"),
        "untouched",
      );
      assert.equal(
        (await original.readdir(paths.stateDirectory)).some((name) =>
          name.includes(".prepare-"),
        ),
        false,
      );
    } finally {
      fs.rename = original.rename;
      fs.lstat = original.lstat;
      fs.unlink = original.unlink;
      fs.rmdir = original.rmdir;
      fs.readdir = original.readdir;
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
}
