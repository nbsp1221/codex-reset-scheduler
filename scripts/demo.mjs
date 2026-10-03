import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "linux") {
  throw new Error(
    "This synthetic CLI demo requires Linux; it does not validate a native scheduler.",
  );
}

const root = fileURLToPath(new URL("../", import.meta.url));
const cli =
  process.argv[2] === undefined
    ? join(root, ".test-dist", "src", "cli.js")
    : resolve(process.argv[2]);
const fake = join(root, ".test-dist", "test", "helpers", "fake-app-server.js");
await access(cli);
await access(fake);

const temporary = await mkdtemp(join(tmpdir(), "resetrail-synthetic-demo-"));
const bin = join(temporary, "bin");
const state = join(temporary, "state");
const config = join(temporary, "config");
const registry = join(temporary, "synthetic-scheduler.json");
const requestLog = join(temporary, "synthetic-requests.jsonl");
const environment = {
  ...process.env,
  PATH: bin,
  CODEX_HOME: join(temporary, "empty-codex-home"),
  XDG_STATE_HOME: state,
  XDG_CONFIG_HOME: config,
  RESETRAIL_FAKE_REQUEST_LOG: requestLog,
  RESETRAIL_FAKE_EPOCH_SECONDS: String(Math.floor(Date.now() / 1_000) - 6_400),
  RESETRAIL_FAKE_REFUSE_CONSUME: "1",
};

async function executable(name, body) {
  const path = join(bin, name);
  await writeFile(path, "#!/usr/bin/env node\n" + body, { mode: 0o700 });
  await chmod(path, 0o700);
}

function run(arguments_) {
  const completed = spawnSync(
    process.execPath,
    [cli, ...arguments_, "--json"],
    {
      env: environment,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  assert.equal(completed.error, undefined, "Synthetic CLI process must start.");
  assert.equal(completed.status, 0, completed.stderr);
  const response = JSON.parse(completed.stdout);
  assert.equal(response.ok, true);
  console.log("$ resetpilot " + arguments_.join(" ") + " --json");
  return response.data;
}

try {
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(registry, "[]");
  await executable(
    "codex",
    `
if (process.argv.slice(2).join(" ") === "--version") {
  console.log("codex-cli synthetic");
} else {
  if (process.argv.slice(2).join(" ") !== "app-server --stdio") {
    throw new Error("Only synthetic app-server stdio is allowed.");
  }
  await import(${JSON.stringify(pathToFileURL(fake).href)});
}
`,
  );
  const scheduler = `
import { basename, resolve, sep } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const registry = ${JSON.stringify(registry)};
const config = ${JSON.stringify(config)};
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
let installed = JSON.parse(readFileSync(registry, "utf8"));
if (name === "systemctl") {
  if (args.join(" ") === "--user show-environment") {
    console.log("SYNTHETIC=1");
  } else if (args.join(" ") === "--user daemon-reload") {
    // No native scheduler is contacted.
  } else if (args[0] === "--user" && args[1] === "enable" && args[2] === "--now") {
    installed.push(args[3]);
  } else if (args[0] === "--user" && args[1] === "disable" && args[2] === "--now") {
    installed = installed.filter((unit) => unit !== args[3]);
  } else if (args[0] === "--user" && args[1] === "show") {
    if (installed.includes(args[2])) {
      console.log("LoadState=loaded\\nUnitFileState=enabled\\nActiveState=active");
    } else {
      process.exitCode = 1;
    }
  } else {
    throw new Error("Unsupported synthetic systemctl arguments.");
  }
  writeFileSync(registry, JSON.stringify(installed));
} else if (name === "systemd-analyze") {
  if (args.join(" ") === "--user --version") {
    console.log("systemd synthetic");
  } else if (args[0] === "--user" && args[1] === "verify") {
    for (const path of args.slice(2)) {
      if (!resolve(path).startsWith(config + sep)) throw new Error("Artifact escaped temporary directory.");
      readFileSync(path);
    }
  } else {
    throw new Error("Unsupported synthetic validator arguments.");
  }
} else if (name === "timedatectl" || name === "loginctl") {
  console.log("yes");
} else {
  throw new Error("Unsupported synthetic executable.");
}
`;
  for (const name of [
    "systemctl",
    "systemd-analyze",
    "timedatectl",
    "loginctl",
  ]) {
    await executable(name, scheduler);
  }

  console.log(
    "SYNTHETIC DEMO — actual CLI, fake Codex and scheduler, no consume, no native tasks.",
  );
  const doctor = run(["doctor"]);
  assert.equal(doctor.ok, true);
  console.log("  doctor: OK (synthetic checks)");
  const resets = run(["resets", "--timezone", "UTC"]);
  assert.equal(resets.availableCount, 2);
  const selector = resets.resets[0].selector;
  console.log("  currently visible synthetic resets: 2; selected " + selector);
  assert.equal(run(["status"]).initialized, false);
  console.log("  status: no plans");
  const plan = run(["plan", "--credit", selector]);
  assert.equal(plan.plannedResetCount, 1);
  console.log(
    "  preview: one current synthetic credit, 10 minutes before expiry",
  );
  const preview = run(["arm", "--credit", selector, "--dry-run"]);
  assert.equal(preview.dryRun, true);
  await assert.rejects(access(state), { code: "ENOENT" });
  await assert.rejects(access(config), { code: "ENOENT" });
  console.log("  dry-run: no state or scheduler files created");
  const armed = run(["arm", "--credit", selector, "--yes"]);
  assert.equal(armed.plans.length, 1);
  const planId = armed.plans[0].planId;
  const status = run(["status", "--plan", planId]);
  assert.equal(status.plans[0].status, "armed");
  assert.equal(status.plans[0].scheduler.installed, true);
  assert.equal(status.plans[0].scheduler.enabled, true);
  console.log("  status: armed; synthetic scheduler registered");
  assert.equal(run(["disarm", "--plan", planId, "--dry-run"]).dryRun, true);
  console.log("  cancellation preview: one plan");
  assert.equal(run(["disarm", "--plan", planId, "--yes"]).dryRun, false);
  const cancelled = run(["status", "--plan", planId]);
  assert.equal(cancelled.plans[0].status, "disarmed");
  assert.equal(cancelled.plans[0].scheduler.installed, false);
  console.log("  status: disarmed; synthetic scheduler removed");
  const logs = run(["logs", "--plan", planId]);
  assert.deepEqual(
    logs.events.map((event) => event.event),
    ["plan-armed"],
  );
  console.log("  logs: plan-armed; cancellation confirmed by status");
  const requests = (await readFile(requestLog, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    requests.some(
      (request) => request.method === "account/rateLimitResetCredit/consume",
    ),
    false,
  );
  assert.deepEqual(JSON.parse(await readFile(registry, "utf8")), []);
  assert.deepEqual(await readdir(join(config, "systemd", "user")), []);
  console.log(
    "PASS: current-credit arm → status → disarm → status → logs; zero consume requests.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
  await assert.rejects(access(temporary), { code: "ENOENT" });
  console.log(
    "Cleanup: temporary synthetic state, runtimes and scheduler files removed.",
  );
}
