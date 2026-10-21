import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test(
  "doctor bounds a scheduler probe that ignores termination",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "resetrail-synthetic-doctor-"),
    );
    try {
      const executable = join(directory, "schtasks.exe");
      await writeFile(
        executable,
        `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 7000);\n`,
      );
      await chmod(executable, 0o700);
      const moduleUrl = new URL(
        "../../src/application/doctor-service.js",
        import.meta.url,
      ).href;
      const started = Date.now();
      const completed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { inspectSchedulerEnvironment } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await inspectSchedulerEnvironment('win32')));`,
        ],
        {
          env: { ...process.env, PATH: directory },
          encoding: "utf8",
          timeout: 9000,
        },
      );
      assert.equal(completed.error, undefined);
      assert.equal(completed.status, 0, completed.stderr);
      assert.equal(
        (JSON.parse(completed.stdout) as { ready: boolean }).ready,
        false,
      );
      assert.ok(Date.now() - started < 6500);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
