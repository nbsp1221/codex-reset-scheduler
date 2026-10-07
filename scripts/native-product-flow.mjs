import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, homedir, release } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { inspectSchedulerEnvironment } from "../dist/application/doctor-service.js";
import { resolveExecutable } from "../dist/platform/executables.js";
import { creditSelector } from "../dist/domain/policy.js";
import { managedPaths } from "../dist/persistence/paths.js";
import { hashDirectory } from "../dist/runtime/installer.js";
import { schedulerAdapter } from "../dist/scheduler/index.js";

// Only Codex is fake. Package, CLI, scheduler, snapshot, worker and state are real.
const script = fileURLToPath(import.meta.url);
const repository = fileURLToPath(new URL("../", import.meta.url));
const digest = (data) => createHash("sha256").update(data).digest("hex");
const sourceFiles = [
  "scripts/native-product-flow.mjs",
  "test/helpers/fake-app-server.ts",
];
const codeHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (f) => [
      f,
      digest(await readFile(join(repository, f))),
    ]),
  ),
);
const execute = promisify(execFile);
const paths = managedPaths();
const adapter = schedulerAdapter(paths);
const errorCode = (error) =>
  String(
    error.code ??
      (/^[a-z][a-z0-9_]+$/u.test(error.message) ? error.message : error.name),
  );
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function rootFor(nonce) {
  assert.match(nonce, /^[a-f0-9]{32}$/u);
  return join(await realpath(homedir()), ".resetrail-product-flow-" + nonce);
}
async function identity() {
  const value =
    process.platform === "win32"
      ? (
          await execute(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
            ],
            { timeout: 10000, windowsHide: true },
          )
        ).stdout.trim()
      : `uid:${process.getuid?.()}`;
  return {
    hash: digest(value),
    ordinary:
      process.platform === "win32"
        ? /^S-1-\d+(?:-\d+)+$/u.test(value) &&
          !["S-1-5-18", "S-1-5-19", "S-1-5-20"].includes(value)
        : process.getuid?.() > 0,
  };
}
async function save(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
function command(executable, args, options = {}) {
  const r = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    ...options,
  });
  assert.equal(r.error, undefined, "child process must start");
  if (r.status !== 0) {
    const error = new Error("child_command_failed");
    error.childExitCode = r.status;
    try {
      error.cliErrorCode = JSON.parse(r.stderr).error.code;
    } catch {
      /* Raw diagnostics may contain private paths. */
    }
    throw error;
  }
  return { stdout: r.stdout, pid: r.pid, exitedAt: new Date().toISOString() };
}
const npmCLI =
  process.env.npm_execpath ??
  (process.platform === "win32"
    ? join(
        dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      )
    : await resolveExecutable("npm"));
function npm(args, options = {}) {
  // The npm CLI is a JavaScript entrypoint; no shell is needed on Windows.
  return command(process.execPath, [npmCLI, ...args], options);
}
function cli(root, scenario, args) {
  assert.ok(!args.includes("__worker"), "the harness never invokes a worker");
  const env = {
    ...process.env,
    PATH: join(root, "bin") + delimiter + process.env.PATH,
    CODEX_HOME: join(root, scenario),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  const r = command(
    process.execPath,
    [
      join(
        root,
        "install",
        "node_modules",
        "codex-reset-scheduler",
        "dist",
        "cli.js",
      ),
      ...args,
      "--json",
    ],
    { env },
  );
  const response = JSON.parse(r.stdout);
  assert.equal(response.ok, true);
  return { data: response.data, pid: r.pid, exitedAt: r.exitedAt };
}
async function createLauncher(root) {
  const bin = join(root, "bin");
  await mkdir(bin);
  const launcher = join(bin, "fake-codex.mjs");
  await writeFile(
    launcher,
    `import { join } from "node:path";\nif (process.argv.slice(2).join(" ") === "--version") console.log("codex-cli synthetic-native");\nelse { if (process.argv.slice(2).join(" ") !== "app-server --stdio") throw new Error("Only fake app-server is allowed"); process.env.RESETRAIL_FAKE_STATE_FILE=join(process.env.CODEX_HOME,"resetrail-fake.json"); await import(${JSON.stringify(pathToFileURL(join(repository, ".test-dist", "test", "helpers", "fake-app-server.js")).href)}); }\n`,
    { mode: 0o700 },
  );
  if (process.platform !== "win32") {
    // A shebang script is directly executable by the unchanged product spawn path.
    await writeFile(
      join(bin, "codex"),
      `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(launcher).href)});\n`,
      { mode: 0o700 },
    );
    return;
  }
  const verbatim = (value) => '@"' + value.replaceAll('"', '""') + '"';
  const source = `using System; using System.Diagnostics; using System.Threading.Tasks;
public class FakeCodex { public static int Main(string[] args) {
 if(args.Length==1 && args[0]=="--version") { Console.WriteLine("codex-cli synthetic-native"); return 0; }
 if(args.Length!=2 || args[0]!="app-server" || args[1]!="--stdio") return 2;
 var info = new ProcessStartInfo(${verbatim(process.execPath)}, ((char)34).ToString() + ${verbatim(launcher)} + ((char)34).ToString() + " app-server --stdio");
 info.UseShellExecute=false; info.CreateNoWindow=true; info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
 using(var child=Process.Start(info)) {
  var input=Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); input.ContinueWith(t=>child.StandardInput.Close());
  var output=child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput()); var error=child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
  child.WaitForExit(); Task.WaitAll(output,error); return child.ExitCode;
 } } }`;
  const sourceFile = join(root, "launcher.cs");
  await writeFile(sourceFile, source);
  const ps = join(root, "compile-launcher.ps1");
  const psQuote = (v) => "'" + v.replaceAll("'", "''") + "'";
  await writeFile(
    ps,
    `$ErrorActionPreference='Stop'; Add-Type -Path ${psQuote(sourceFile)} -OutputAssembly ${psQuote(join(bin, "codex.exe"))} -OutputType ConsoleApplication\n`,
  );
  command("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", ps]);
}
async function requests(root, name) {
  const file = join(root, name, "requests.jsonl");
  return (await exists(file))
    ? (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
}
async function cleanup(report) {
  const result = {
    verified: false,
    nativeAbsent: true,
    filesAbsent: true,
    rootRemoved: !report.rootCreated,
  };
  const root = await rootFor(report.nonce);
  try {
    assert.equal((await identity()).hash, report.identityHash);
    if (report.ownsProductPaths && (await exists(paths.stateFile))) {
      const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
      assert.ok(
        state.plans.every((p) =>
          p.creditId.startsWith(`synthetic-native-${report.nonce}-`),
        ),
        "never clean unrelated product plans",
      );
      for (const p of state.plans) {
        await adapter.remove(p);
        result.nativeAbsent &&= !(await adapter.inspect(p)).installed;
        const inspection = adapter.preview(p, {
          command: process.execPath,
          arguments: [],
          environment: {},
          stateDirectory: paths.stateDirectory,
          codexHome: root,
          stdoutPath: join(root, "stdout"),
          stderrPath: join(root, "stderr"),
        });
        for (const file of inspection.files)
          result.filesAbsent &&= !(await exists(file.path));
      }
      result.nativeAbsent &&= (await inspectSchedulerEnvironment()).ready;
    }
    if (result.nativeAbsent && result.filesAbsent && report.ownsProductPaths) {
      for (const directory of [
        ...new Set([paths.logDirectory, paths.stateDirectory]),
      ]) {
        if (await exists(directory)) {
          assert.equal(await realpath(directory), directory);
          await rm(directory, { recursive: true, force: true });
        }
      }
      result.filesAbsent &&=
        !(await exists(paths.stateDirectory)) &&
        !(await exists(paths.logDirectory));
    }
    if (result.nativeAbsent && result.filesAbsent && report.rootCreated) {
      assert.equal(await realpath(root), root);
      await rm(root, { recursive: true, force: true });
    }
    result.rootRemoved = !(await exists(root));
    result.verified =
      result.nativeAbsent && result.filesAbsent && result.rootRemoved;
  } catch (error) {
    result.errorCode = errorCode(error);
  }
  return result;
}
async function probe(reportFile) {
  if (await exists(reportFile)) throw new Error("report_already_exists");
  const user = await identity();
  const report = {
    schemaVersion: 2,
    status: "running",
    createdAt: new Date().toISOString(),
    platform: process.platform,
    osRelease: release(),
    architecture: arch(),
    node: process.version,
    nonce: randomBytes(16).toString("hex"),
    codeHashes,
    identityHash: user.hash,
    rootCreated: false,
    ownsProductPaths: false,
    phase: "preflight",
    cases: {},
  };
  await save(reportFile, report);
  const root = await rootFor(report.nonce);
  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
  });
  process.once("SIGTERM", () => {
    interrupted = true;
  });
  try {
    report.readiness = await inspectSchedulerEnvironment();
    if (!user.ordinary || !report.readiness.ready) {
      report.status = "unsupported";
      report.reason = "ordinary_scheduler_user_session_required";
      return;
    }
    if (
      (await exists(paths.stateDirectory)) ||
      (await exists(paths.logDirectory))
    ) {
      report.status = "unsupported";
      report.reason = "existing_product_paths_preserved";
      return;
    }
    await mkdir(root, { mode: 0o700 });
    report.rootCreated = true;
    await save(reportFile, report);
    report.phase = "install-package";
    const packed = JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
        cwd: repository,
      }).stdout,
    )[0];
    const tar = join(root, packed.filename);
    report.package = {
      name: packed.name,
      version: packed.version,
      sha256: digest(await readFile(tar)),
      files: packed.files.length,
    };
    npm([
      "install",
      "--prefix",
      join(root, "install"),
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(root, "npm-cache"),
      tar,
    ]);
    const installed = join(
      root,
      "install",
      "node_modules",
      "codex-reset-scheduler",
    );
    const metadata = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    assert.equal(metadata.bin["codex-reset-scheduler"], "dist/cli.js");
    assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0);
    report.package.installedBinVerified = await exists(
      join(
        root,
        "install",
        "node_modules",
        ".bin",
        process.platform === "win32"
          ? "codex-reset-scheduler.cmd"
          : "codex-reset-scheduler",
      ),
    );
    assert.equal(report.package.installedBinVerified, true);
    const installedHash = await hashDirectory(join(installed, "dist"));
    report.package.installedDistSHA256 = installedHash;
    await createLauncher(root);
    const names = ["success", "cancel", "account-change", "target-change"];
    // Leave four minutes for all real CLI arm commands; launchd is minute-resolution.
    const firstAt = Math.ceil((Date.now() + 240000) / 60000) * 60;
    for (const name of names) {
      await mkdir(join(root, name), { mode: 0o700 });
      const id = `synthetic-native-${report.nonce}-${name}-target`;
      const other = `synthetic-native-${report.nonce}-${name}-other`;
      const credit = (creditId) => ({
        id: creditId,
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: firstAt - 10000,
        expiresAt: firstAt + 120,
        title: "Synthetic native flow",
        description: "Fixture only",
      });
      await save(join(root, name, "resetrail-fake.json"), {
        nonce: report.nonce,
        accountEmail: `synthetic-${name}@example.invalid`,
        requestLog: join(root, name, "requests.jsonl"),
        productStateFile: paths.stateFile,
        credits: [credit(id), credit(other)],
        results: {},
      });
      report.cases[name] = {
        selector: creditSelector(id),
        expectedTarget: id,
        untouchedTarget: other,
      };
    }
    assert.equal(cli(root, "success", ["doctor"]).data.ok, true);
    assert.equal(cli(root, "success", ["status"]).data.initialized, false);
    const visible = cli(root, "success", ["resets", "--timezone", "UTC"]).data;
    assert.equal(visible.availableCount, 2);
    assert.ok(
      visible.resets.some((r) => r.selector === report.cases.success.selector),
    );
    assert.equal(
      cli(root, "success", [
        "arm",
        "--credit",
        report.cases.success.selector,
        "--before",
        "2m",
        "--dry-run",
      ]).data.dryRun,
      true,
    );
    assert.equal(await exists(paths.stateDirectory), false);
    report.ownsProductPaths = true;
    report.phase = "arm-product-cli";
    await save(reportFile, report);
    for (const name of names) {
      const r = cli(root, name, [
        "arm",
        "--credit",
        report.cases[name].selector,
        "--before",
        "2m",
        "--yes",
      ]);
      assert.equal(r.data.plans.length, 1);
      const plan = r.data.plans[0];
      report.cases[name] = {
        ...report.cases[name],
        planId: plan.planId,
        triggerTimes: plan.triggerTimes,
        armPID: r.pid,
        armExitedAt: r.exitedAt,
      };
      assert.ok(
        Date.parse(plan.triggerTimes[0]) > Date.parse(r.exitedAt),
        "arm CLI exits before the natural timer",
      );
      const status = cli(root, name, ["status", "--plan", plan.planId]).data
        .plans[0];
      assert.equal(status.status, "armed");
      assert.equal(status.scheduler.installed, true);
      assert.equal(status.scheduler.enabled, true);
      await save(reportFile, report);
    }
    const cancelled = report.cases.cancel;
    assert.equal(
      cli(root, "cancel", ["disarm", "--plan", cancelled.planId, "--dry-run"])
        .data.dryRun,
      true,
    );
    cli(root, "cancel", ["disarm", "--plan", cancelled.planId, "--yes"]);
    cancelled.cancelledAt = new Date().toISOString();
    const cancelStatus = cli(root, "cancel", [
      "status",
      "--plan",
      cancelled.planId,
    ]).data.plans[0];
    assert.equal(cancelStatus.status, "disarmed");
    assert.equal(cancelStatus.scheduler.installed, false);
    for (const name of ["account-change", "target-change"]) {
      const file = join(root, name, "resetrail-fake.json");
      const f = JSON.parse(await readFile(file, "utf8"));
      if (name === "account-change")
        f.accountEmail = "synthetic-switched@example.invalid";
      else f.credits[0].id = `synthetic-native-${report.nonce}-replacement`;
      await save(file, f);
      report.cases[name].changedAt = new Date().toISOString();
      assert.ok(Date.now() < firstAt * 1000);
    }
    report.phase = "wait-for-natural-product-timers";
    await save(reportFile, report);
    const deadline = (firstAt + 60) * 1000 + 20000;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error("probe_interrupted");
      await delay(1000);
    }
    report.phase = "verify-product-results";
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    for (const name of names) {
      const c = report.cases[name];
      const messages = await requests(root, name);
      const consumes = messages.filter(
        (m) => m.method === "account/rateLimitResetCredit/consume",
      );
      const status = cli(root, name, ["status", "--plan", c.planId]).data
        .plans[0];
      const logs = cli(root, name, ["logs", "--plan", c.planId]).data.events;
      const p = state.plans.find((p) => p.planId === c.planId);
      assert.equal(p.creditId, c.expectedTarget);
      assert.equal(p.runtimeSha256, installedHash);
      const f = JSON.parse(
        await readFile(join(root, name, "resetrail-fake.json"), "utf8"),
      );
      assert.ok(f.credits.some((r) => r.id === c.untouchedTarget));
      if (name === "success") {
        assert.equal(status.status, "succeeded");
        assert.equal(consumes.length, 1);
        const m = consumes[0];
        assert.deepEqual(m.params, {
          creditId: c.expectedTarget,
          idempotencyKey: p.attempt.idempotencyKey,
        });
        assert.match(
          m.params.idempotencyKey,
          /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u,
        );
        assert.deepEqual(m.persistedAttempt, {
          planId: c.planId,
          status: "attempting",
          creditId: c.expectedTarget,
          idempotencyKey: m.params.idempotencyKey,
        });
        assert.equal(m.nonce, report.nonce);
        assert.equal(m.identityHash, user.hash);
        assert.notEqual(m.pid, c.armPID);
        assert.ok(Date.parse(m.startedAt) > Date.parse(c.armExitedAt));
        assert.ok(
          Date.parse(m.receivedAt) >= firstAt * 1000 &&
            Date.parse(m.receivedAt) < (firstAt + 120) * 1000,
        );
        assert.equal(
          f.credits.some((r) => r.id === c.expectedTarget),
          false,
        );
        assert.deepEqual(f.results[m.params.idempotencyKey], {
          creditId: c.expectedTarget,
          outcome: "reset",
        });
        assert.deepEqual(
          logs.map((e) => e.event),
          ["plan-armed", "consume-result"],
        );
        assert.equal(logs[1].status, "succeeded");
        assert.equal(logs[1].outcome, "reset");
        c.consumeEvidence = { ...m, id: undefined };
        c.resultUUIDRetained = true;
        c.exactTargetRetired = true;
      } else {
        assert.equal(consumes.length, 0);
        assert.deepEqual(
          logs.map((e) => e.event),
          ["plan-armed"],
        );
        assert.equal(
          status.status,
          name === "cancel"
            ? "disarmed"
            : name === "account-change"
              ? "paused"
              : "unavailable",
        );
        if (name === "cancel")
          assert.equal(
            messages.filter(
              (m) => Date.parse(m.startedAt) > Date.parse(c.cancelledAt),
            ).length,
            0,
          );
        else {
          assert.equal(
            status.terminalReason,
            name === "account-change"
              ? "account_changed"
              : "target_unavailable",
          );
          const workerReads = messages.filter(
            (m) =>
              m.method === "account/read" &&
              Date.parse(m.startedAt) >= firstAt * 1000,
          );
          assert.ok(workerReads.length > 0);
          assert.ok(
            workerReads.every(
              (m) => m.identityHash === user.hash && m.nonce === report.nonce,
            ),
          );
          c.nativeWorkerEvidence = workerReads.map(
            ({ pid, parentPid, startedAt, receivedAt }) => ({
              pid,
              parentPid,
              startedAt,
              receivedAt,
            }),
          );
        }
      }
      c.status = status.status;
      c.terminalReason = status.terminalReason;
      c.consumeRequests = consumes.length;
      c.logEvents = logs.map((e) => ({
        event: e.event,
        status: e.status,
        outcome: e.outcome,
      }));
      c.runtimeMatchesInstalledPackage = true;
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.reason = errorCode(error);
    report.failure = {
      childExitCode: error.childExitCode,
      cliErrorCode: error.cliErrorCode,
    };
  } finally {
    report.cleanup = await cleanup(report);
    if (!report.cleanup.verified) {
      report.status = "failed";
      report.reason = "cleanup_unverified";
    }
    report.completedAt = new Date().toISOString();
    await save(reportFile, report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "passed" ? 0 : 1;
  }
}
async function recover(file) {
  if (!(await exists(file))) {
    console.log("No report; no identified owned artifacts.");
    return;
  }
  const report = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(report.codeHashes, codeHashes);
  assert.equal(report.platform, process.platform);
  if (!report.cleanup?.verified) report.cleanup = await cleanup(report);
  await save(file, report);
  console.log(
    JSON.stringify({ status: report.status, cleanup: report.cleanup }),
  );
  process.exitCode = report.cleanup.verified ? 0 : 1;
}
const [mode, value, extra] = process.argv.slice(2);
try {
  if (mode === "--help" && value === undefined)
    console.log(
      "Installed product native flow: --report <file> or --cleanup <file>. Fake Codex only; no manual worker invocation.",
    );
  else if (!value || extra) throw new Error("invalid_probe_arguments");
  else if (mode === "--report") await probe(resolve(value));
  else if (mode === "--cleanup") await recover(resolve(value));
  else throw new Error("invalid_probe_arguments");
} catch (error) {
  console.error("Native product flow failed:", errorCode(error));
  process.exitCode = 1;
}
