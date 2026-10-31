import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { readVersion } from "./release-version.mjs";

async function npmEntrypoint() {
  if (process.platform === "win32")
    return join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      return await realpath(join(directory, "npm"));
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error("npm CLI was not found.");
}

function run(executable, args, options) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    ...options,
  });
  assert.equal(result.error, undefined, "Package smoke subprocess must start.");
  assert.equal(result.status, 0, "Package smoke command failed: " + args[0]);
  return result.stdout;
}

export async function smokePackage(spec, expectedVersion, expectedIntegrity) {
  const temporary = await mkdtemp(join(tmpdir(), "scheduler-package-"));
  try {
    const home = join(temporary, "home");
    await mkdir(home);
    const environment = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(temporary, "local"),
      APPDATA: join(temporary, "roaming"),
      XDG_CONFIG_HOME: join(temporary, "config"),
      XDG_DATA_HOME: join(temporary, "data"),
      XDG_STATE_HOME: join(temporary, "state"),
      CODEX_HOME: join(temporary, "codex"),
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      npm_config_userconfig: join(temporary, "user.npmrc"),
      npm_config_globalconfig: join(temporary, "global.npmrc"),
      npm_config_cache: join(temporary, "cache"),
    };
    const registry = expectedIntegrity !== undefined;
    const npmCLI = await npmEntrypoint();
    run(
      process.execPath,
      [
        npmCLI,
        "install",
        "--prefix",
        temporary,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        registry ? "--prefer-online" : "--offline",
        "--registry=https://registry.npmjs.org",
        spec,
      ],
      { cwd: temporary, env: environment },
    );
    const packageDirectory = join(
      temporary,
      "node_modules",
      "codex-reset-scheduler",
    );
    const installed = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    assert.equal(installed.name, "codex-reset-scheduler");
    assert.equal(installed.version, expectedVersion);
    assert.equal(installed.bin["codex-reset-scheduler"], "dist/cli.js");
    await access(join(packageDirectory, "dist", "cli-core.d.ts"));
    await access(
      join(
        temporary,
        "node_modules",
        ".bin",
        "codex-reset-scheduler" + (process.platform === "win32" ? ".cmd" : ""),
      ),
    );
    if (registry) {
      const lock = JSON.parse(
        await readFile(join(temporary, "package-lock.json"), "utf8"),
      );
      assert.equal(
        lock.packages["node_modules/codex-reset-scheduler"].integrity,
        expectedIntegrity,
      );
    }
    const standalone = join(temporary, "standalone");
    const runtime = join(standalone, "runtime");
    await mkdir(standalone);
    await cp(join(packageDirectory, "dist"), runtime, { recursive: true });
    await assert.rejects(access(join(standalone, "package.json")), {
      code: "ENOENT",
    });
    for (const bin of [
      join(packageDirectory, installed.bin["codex-reset-scheduler"]),
      join(runtime, "cli.js"),
    ]) {
      const cli = (...args) =>
        run(process.execPath, [bin, ...args], {
          cwd: temporary,
          env: environment,
        });
      const version = JSON.parse(cli("version", "--json"));
      assert.equal(version.ok, true);
      assert.equal(version.data.version, expectedVersion);
      assert.ok(
        cli("--help").includes("codex-reset-scheduler " + expectedVersion),
      );
      const status = JSON.parse(cli("status", "--json"));
      assert.equal(status.ok, true);
      assert.deepEqual(status.data, { initialized: false, plans: [] });
    }
    for (const state of [
      join(temporary, "state", "resetrail"),
      join(temporary, "local", "Resetrail"),
      join(home, "Library", "Application Support", "Resetrail"),
    ])
      await assert.rejects(access(state), { code: "ENOENT" });
    console.log(
      "Installed package and dist-only runtime smoke passed: codex-reset-scheduler@" +
        expectedVersion,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { version } = await readVersion();
  if (process.argv[2]) {
    await smokePackage(resolve(process.argv[2]), version);
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "scheduler-pack-"));
  try {
    assert.ok(
      process.env.npm_execpath,
      "Run through pnpm test:package to pack.",
    );
    run(
      process.execPath,
      [
        process.env.npm_execpath,
        "pack",
        "--out",
        join(temporary, "package.tgz"),
      ],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env },
    );
    await smokePackage(join(temporary, "package.tgz"), version);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
