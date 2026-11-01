import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const version of ["1.2.3", "2.0.0-rc.1"]) {
  test(`build embeds manifest version ${version}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "scheduler-version-"));
    try {
      await mkdir(join(root, "scripts"));
      await mkdir(join(root, "src"));
      await copyFile(
        new URL("./generate-version.mjs", import.meta.url),
        join(root, "scripts", "generate-version.mjs"),
      );
      await writeFile(join(root, "package.json"), JSON.stringify({ version }));
      execFileSync(process.execPath, [
        join(root, "scripts", "generate-version.mjs"),
      ]);
      assert.equal(
        await readFile(join(root, "src", "version.ts"), "utf8"),
        `export const VERSION = ${JSON.stringify(version)};\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
