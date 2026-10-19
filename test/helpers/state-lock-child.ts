import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { managedPaths } from "../../src/persistence/paths.js";

const home = process.argv[2];
const mode = process.argv[3];
if (!home) throw new Error("Missing isolated home");
const paths = managedPaths({ platform: "linux", home, environment: {} });
const lockPath = `${paths.lockDirectory}.v2`;
let paused = false;
async function barrier(event: string): Promise<void> {
  process.send?.({ event });
  await new Promise<void>((resolve) =>
    process.once("message", () => resolve()),
  );
}

const writeFile = fs.writeFile;
fs.writeFile = async (...args: Parameters<typeof fs.writeFile>) => {
  if (typeof args[0] === "string" && args[0].includes(".protocol.")) {
    if (mode === "before-protocol") await barrier("before-protocol");
    await writeFile(...args);
    if (mode === "after-protocol") await barrier("after-protocol");
    return;
  }
  if (typeof args[0] === "string" && args[0].includes(".prepare-")) {
    if (mode === "before-marker") await barrier("before-marker");
    if (mode === "write-fails")
      throw Object.assign(new Error("Synthetic marker write failure"), {
        code: "EIO",
      });
    await writeFile(...args);
    if (mode === "after-marker") await barrier("after-marker");
    return;
  }
  return writeFile(...args);
};
const rename = fs.rename;
let renameCalls = 0;
fs.rename = async (...args: Parameters<typeof fs.rename>) => {
  if (String(args[1]) === lockPath) {
    renameCalls += 1;
    process.send?.({ event: "rename-attempt" });
    const code =
      mode === "rename-io"
        ? "EIO"
        : mode === "rename-denied"
          ? "EACCES"
          : mode === "rename-eperm"
            ? "EPERM"
            : mode === "missing-collision" && renameCalls === 1
              ? "EEXIST"
              : null;
    if (code)
      throw Object.assign(new Error("Synthetic rename failure"), { code });
  }
  return rename(...args);
};
const lstat = fs.lstat;
fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
  const result = await lstat(...args);
  if (
    mode === "release-on-owner-inspection" &&
    !paused &&
    String(args[0]).startsWith(join(lockPath, "owner-v2."))
  ) {
    paused = true;
    await barrier("owner-observed");
  }
  return result;
}) as typeof fs.lstat;
const unlink = fs.unlink;
fs.unlink = async (...args: Parameters<typeof fs.unlink>) => {
  if (
    mode === "reap-unlink" &&
    !paused &&
    String(args[0]).startsWith(join(lockPath, "owner-v2."))
  ) {
    paused = true;
    await barrier("before-stale-unlink");
    try {
      return await unlink(...args);
    } catch (error) {
      process.send?.({ event: "stale-unlink-missed" });
      throw error;
    }
  }
  return unlink(...args);
};
const rmdir = fs.rmdir;
fs.rmdir = async (...args: Parameters<typeof fs.rmdir>) => {
  if (
    !paused &&
    String(args[0]) === lockPath &&
    (mode === "reap-rmdir" || mode === "release-rmdir")
  ) {
    paused = true;
    await barrier("before-rmdir");
    try {
      return await rmdir(...args);
    } catch (error) {
      process.send?.({ event: "stale-rmdir-rejected" });
      throw error;
    }
  }
  return rmdir(...args);
};
// Simulate uncertain process probes without changing the production API.
if (mode === "probe-eperm" || mode === "probe-unknown") {
  process.kill = () => {
    throw Object.assign(new Error("Synthetic process probe failure"), {
      code: mode === "probe-eperm" ? "EPERM" : "EIO",
    });
  };
}
syncBuiltinESMExports();
const { StateStore } = await import("../../src/persistence/state-store.js");
try {
  await new StateStore(paths).withLock(async () => {
    await barrier("entered");
  });
  process.send?.({ event: "released" });
} catch (error) {
  process.send?.({
    event: "failed",
    code: (error as { code?: string }).code,
    message: (error as Error).message,
  });
} finally {
  process.disconnect();
}
