import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, homedir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectSchedulerEnvironment } from "../dist/application/doctor-service.js";
import { buildTriggerPlan, creditSelector } from "../dist/domain/policy.js";
import { managedPaths } from "../dist/persistence/paths.js";
import { schedulerAdapter } from "../dist/scheduler/index.js";

// Capability probe only: no app-server, credentials, account state, or consume.
const script = fileURLToPath(import.meta.url);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const codeSHA = digest(await readFile(script));
const execute = promisify(execFile);
const prefix = ".resetrail-native-probe-";
const latenessLimit = 45_000;
const errorCode = (error) =>
  String(
    error.code ??
      (/^[a-z][a-z0-9_]+$/u.test(error.message) ? error.message : error.name) ??
      "probe_error",
  );

async function identity() {
  if (process.platform === "win32") {
    const { stdout } = await powershell(
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    );
    const sid = stdout.trim();
    if (!/^S-1-\d+(?:-\d+)+$/u.test(sid))
      throw new Error("invalid_user_identity");
    return {
      hash: digest(sid),
      ordinaryUser: !["S-1-5-18", "S-1-5-19", "S-1-5-20"].includes(sid),
    };
  }
  const uid = process.getuid?.();
  return {
    hash: digest(`uid:${uid}`),
    ordinaryUser: Number.isInteger(uid) && uid !== 0,
  };
}

function powershell(command) {
  return execute(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
}

async function rootFor(nonce) {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error("invalid_probe_nonce");
  return join(await realpath(homedir()), prefix + nonce);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function planFor(report) {
  const value = report.plan;
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value.planId) ||
    value.triggerTimesUtc.length !== 2
  )
    throw new Error("invalid_probe_plan");
  return {
    planId: value.planId,
    creditSelector: creditSelector("synthetic-native-marker"),
    expiresAt: value.expiresAt,
    scheduler: {
      platform: managedPaths().platform,
      artifactId: value.planId,
      triggerTimesUtc: value.triggerTimesUtc,
    },
  };
}

function pathsFor(root) {
  return { ...managedPaths(), stateDirectory: root };
}

function actionFor(root) {
  return {
    command: process.execPath,
    arguments: [script, "--marker", join(root, "config.json")],
    environment: {
      HOME: homedir(),
      PATH: process.env.PATH ?? "",
      CODEX_HOME: join(root, "no-codex"),
    },
    stateDirectory: root,
    codexHome: join(root, "no-codex"),
    stdoutPath: join(root, "stdout.log"),
    stderrPath: join(root, "stderr.log"),
  };
}

async function marker(configFile) {
  const startedAt = Date.now();
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const root = await rootFor(config.nonce);
  if (
    (await realpath(dirname(configFile))) !== root ||
    config.probeCodeSHA !== codeSHA
  )
    throw new Error("marker_context_mismatch");
  const user = await identity();
  const triggerIndex = config.triggerTimesUtc.findLastIndex(
    (time) => Date.parse(time) <= startedAt,
  );
  const delayMs =
    triggerIndex < 0
      ? null
      : startedAt - Date.parse(config.triggerTimesUtc[triggerIndex]);
  const reason =
    user.hash !== config.identityHash || !user.ordinaryUser
      ? "user-mismatch"
      : startedAt < config.notBefore * 1_000
        ? "too-early"
        : startedAt >= config.expiresAt * 1_000
          ? "expired"
          : delayMs > latenessLimit
            ? "late"
            : "scheduled";
  await appendFile(
    join(root, "events.jsonl"),
    JSON.stringify({
      nonce: config.nonce,
      probeCodeSHA: codeSHA,
      planId: config.planId,
      platform: process.platform,
      identityHash: user.hash,
      pid: process.pid,
      node: process.version,
      startedAt: new Date(startedAt).toISOString(),
      recordedAt: new Date().toISOString(),
      triggerIndex,
      delayMs,
      reason,
    }) + "\n",
    { mode: 0o600 },
  );
  if (reason === "user-mismatch") process.exitCode = 1;
}

async function readEvents(root) {
  if (!(await exists(join(root, "events.jsonl")))) return [];
  return (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

async function diagnostics(report) {
  if (!report.nativeMutationStarted) return {};
  const plan = planFor(report);
  const adapter = schedulerAdapter(pathsFor(await rootFor(report.nonce)));
  const preview = adapter.preview(plan, actionFor(await rootFor(report.nonce)));
  try {
    if (process.platform === "win32") {
      const { stdout } = await powershell(
        `$i=Get-ScheduledTaskInfo -TaskPath '\\Resetrail\\' -TaskName '${plan.planId}'; @{ lastTaskResult=$i.LastTaskResult; missedRuns=$i.NumberOfMissedRuns; lastRunUtc=$i.LastRunTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`,
      );
      return JSON.parse(stdout);
    }
    if (process.platform === "linux") {
      const { stdout } = await execute(
        "systemctl",
        [
          "--user",
          "show",
          `${preview.artifactId}.service`,
          "--property=Result,ExecMainStatus,ActiveState",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      return Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    }
    const { stdout } = await execute(
      "/bin/launchctl",
      ["print", `gui/${process.getuid()}/${preview.artifactId}`],
      { encoding: "utf8", timeout: 10_000 },
    );
    return {
      state: /\bstate = (\w+)/u.exec(stdout)?.[1] ?? null,
      runs: /\bruns = (\d+)/u.exec(stdout)?.[1] ?? null,
      lastExitCode: /last exit code = (-?\d+)/u.exec(stdout)?.[1] ?? null,
    };
  } catch (error) {
    return { available: false, errorCode: errorCode(error) };
  }
}

async function cleanup(report) {
  const result = {
    verified: false,
    nativeAbsent: !report.nativeMutationStarted,
    filesAbsent: true,
    rootRemoved: !report.rootCreated,
  };
  const root = await rootFor(report.nonce);
  try {
    if (report.identityHash && (await identity()).hash !== report.identityHash)
      throw new Error("cleanup_user_mismatch");
    if (
      report.rootCreated &&
      (await exists(root)) &&
      (await realpath(root)) !== root
    )
      throw new Error("cleanup_path_mismatch");
    if (report.nativeMutationStarted) {
      const adapter = schedulerAdapter(pathsFor(root));
      const plan = planFor(report);
      await adapter.remove(plan);
      const inspection = await adapter.inspect(plan);
      const ready = await inspectSchedulerEnvironment();
      result.nativeAbsent = !inspection.installed && ready.ready;
      const preview = adapter.preview(plan, actionFor(root));
      result.filesAbsent = (
        await Promise.all(
          preview.files.map(async (file) => !(await exists(file.path))),
        )
      ).every(Boolean);
    }
    if (result.nativeAbsent && result.filesAbsent) {
      // The canonical path is an exclusive nonce directory under this user's home.
      if (report.rootCreated) await rm(root, { recursive: true, force: true });
      result.rootRemoved = !(await exists(root));
    }
    result.verified =
      result.nativeAbsent && result.filesAbsent && result.rootRemoved;
  } catch (error) {
    result.errorCode = errorCode(error);
  }
  return result;
}

async function save(file, report) {
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}

async function probe(reportFile) {
  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
  });
  process.once("SIGTERM", () => {
    interrupted = true;
  });
  const report = {
    schemaVersion: 1,
    status: "running",
    createdAt: new Date().toISOString(),
    platform: process.platform,
    osRelease: release(),
    architecture: arch(),
    node: process.version,
    nonce: randomBytes(16).toString("hex"),
    probeCodeSHA: codeSHA,
    identityHash: null,
    plan: null,
    phase: "preflight",
    rootCreated: false,
    nativeMutationStarted: false,
    events: [],
  };
  if (await exists(reportFile)) throw new Error("report_already_exists");
  await save(reportFile, report);
  const root = await rootFor(report.nonce);
  try {
    const user = await identity();
    report.identityHash = user.hash;
    report.readiness = await inspectSchedulerEnvironment();
    if (!user.ordinaryUser || !report.readiness.ready) {
      report.status = "unsupported";
      report.reason = !user.ordinaryUser
        ? "ordinary_user_session_required"
        : "scheduler_user_session_unavailable";
      return;
    }
    if (interrupted) throw new Error("probe_interrupted");
    report.phase = "prepare";
    const firstAt = Math.ceil((Date.now() + 90_000) / 60_000) * 60;
    const trigger = buildTriggerPlan({
      nowSeconds: Math.floor(Date.now() / 1_000),
      expiresAt: firstAt + 120,
      beforeSeconds: 120,
    });
    report.plan = {
      planId: randomUUID(),
      notBefore: trigger.notBefore,
      expiresAt: trigger.expiresAt,
      triggerTimesUtc: trigger.triggerTimes.map((time) =>
        new Date(time * 1_000).toISOString(),
      ),
    };
    if (report.plan.triggerTimesUtc.length !== 2)
      throw new Error("unexpected_trigger_plan");
    await mkdir(root, { mode: 0o700 });
    report.rootCreated = true;
    await mkdir(join(root, "no-codex"), { mode: 0o700 });
    await save(join(root, "config.json"), {
      nonce: report.nonce,
      probeCodeSHA: codeSHA,
      identityHash: user.hash,
      ...report.plan,
    });
    const adapter = schedulerAdapter(pathsFor(root));
    const plan = planFor(report);
    const action = actionFor(root);
    const preview = adapter.preview(plan, action);
    if (
      (await adapter.inspect(plan)).installed ||
      (await Promise.all(preview.files.map((file) => exists(file.path)))).some(
        Boolean,
      )
    )
      throw new Error("artifact_collision");
    report.phase = "install";
    report.nativeMutationStarted = true;
    await save(reportFile, report);
    await adapter.install(plan, action);
    report.inspection = await adapter.inspect(plan);
    if (!report.inspection.installed || !report.inspection.enabled)
      throw new Error("native_readback_failed");
    report.phase = "wait-for-timers";
    await save(reportFile, report);
    const deadline = Date.parse(report.plan.triggerTimesUtc[1]) + latenessLimit;
    while (Date.now() <= deadline && !interrupted) {
      report.events = await readEvents(root);
      const eligible = report.events.filter(
        (event) =>
          event.reason === "scheduled" &&
          event.nonce === report.nonce &&
          event.planId === plan.planId &&
          event.probeCodeSHA === codeSHA &&
          event.identityHash === user.hash,
      );
      if (new Set(eligible.map((event) => event.triggerIndex)).size === 2) {
        report.status = "passed";
        break;
      }
      await delay(1_000);
    }
    if (report.status !== "passed") {
      report.status = "failed";
      report.reason = interrupted
        ? "probe_interrupted"
        : "scheduled_markers_not_observed";
    }
  } catch (error) {
    report.status = "failed";
    report.reason = errorCode(error);
  } finally {
    report.diagnostics = await diagnostics(report);
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

async function recover(reportFile) {
  if (!(await exists(reportFile))) {
    console.log("No probe report: no owned artifacts can be identified.");
    return;
  }
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  if (report.probeCodeSHA !== codeSHA || report.platform !== process.platform)
    throw new Error("cleanup_context_mismatch");
  if (!report.cleanup?.verified) report.cleanup = await cleanup(report);
  await save(reportFile, report);
  console.log(
    JSON.stringify({ status: report.status, cleanup: report.cleanup }, null, 2),
  );
  process.exitCode = report.cleanup.verified ? 0 : 1;
}

const [mode, value, extra] = process.argv.slice(2);
try {
  if (mode === "--help" && value === undefined)
    console.log(
      "Native marker capability probe: --report <file>, --cleanup <file>, --marker <private-config>. No Codex calls.",
    );
  else if (!value || extra !== undefined)
    throw new Error("invalid_probe_arguments");
  else if (mode === "--marker") await marker(resolve(value));
  else if (mode === "--report") await probe(resolve(value));
  else if (mode === "--cleanup") await recover(resolve(value));
  else throw new Error("invalid_probe_arguments");
} catch (error) {
  console.error("Native marker probe failed:", errorCode(error));
  process.exitCode = 1;
}
