import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executableVersion } from "../../src/platform/executables.js";

test("executable version reads the current Node version", async () => {
  assert.equal(await executableVersion(process.execPath), process.version);
});

test("missing executable version does not leave the ten-second timer alive", () => {
  const moduleUrl = new URL(
    "../../src/platform/executables.js",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { executableVersion } from ${JSON.stringify(moduleUrl)}; await executableVersion('/nonexistent-resetrail-synthetic-version').catch(() => {});`,
    ],
    { timeout: 3_000, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test(
  "executable version drains stderr and preserves bounded trimmed stdout",
  { skip: process.platform === "win32" },
  async () => {
    await withExecutable(
      "process.stderr.write('e'.repeat(1024 * 1024), () => { process.stdout.write('x'.repeat(1500) + ' version \\n'); });",
      async (path) => {
        assert.equal(
          await executableVersion(path),
          ("x".repeat(1500) + " version \n").slice(-1000).trim(),
        );
      },
    );
  },
);

test(
  "executable version rejects a timed-out executable that ignores SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    await withExecutable(
      "process.on('SIGTERM', () => {}); setTimeout(() => { console.log('too-late'); process.exit(0); }, 13000);",
      async (path) => {
        const started = Date.now();
        await assert.rejects(executableVersion(path), {
          code: "version_check_failed",
        });
        assert.ok(Date.now() - started < 12_000);
      },
    );
  },
);

async function withExecutable(
  body: string,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "resetrail-synthetic-version-"),
  );
  try {
    const path = join(directory, "version-fixture");
    await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
    await chmod(path, 0o700);
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
