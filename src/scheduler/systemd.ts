import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ResetPlan } from "../domain/types.js";
import type { ManagedPaths } from "../persistence/paths.js";
import { atomicWriteText } from "./write.js";
import { systemdQuote } from "./escaping.js";
import type { CommandRunner } from "../platform/command-runner.js";
import type {
  ExecSpec,
  SchedulerAdapter,
  SchedulerInspection,
  SchedulerPreview,
} from "./types.js";

export class SystemdScheduler implements SchedulerAdapter {
  readonly #paths: ManagedPaths;
  readonly #run: CommandRunner;

  constructor(paths: ManagedPaths, run: CommandRunner) {
    this.#paths = paths;
    this.#run = run;
  }

  preview(plan: ResetPlan, action: ExecSpec): SchedulerPreview {
    const name = artifactName(plan.planId);
    const servicePath = join(this.#paths.schedulerDirectory, `${name}.service`);
    const timerPath = join(this.#paths.schedulerDirectory, `${name}.timer`);
    return {
      platform: "systemd",
      artifactId: name,
      files: [
        { path: servicePath, content: renderService(plan, action) },
        { path: timerPath, content: renderTimer(plan) },
      ],
      registration: {
        executable: "systemctl",
        arguments: ["--user", "enable", "--now", `${name}.timer`],
      },
    };
  }

  async install(plan: ResetPlan, action: ExecSpec): Promise<void> {
    const preview = this.preview(plan, action);
    await mkdir(this.#paths.schedulerDirectory, {
      recursive: true,
      mode: 0o700,
    });
    for (const file of preview.files)
      await atomicWriteText(file.path, file.content, 0o600);
    await this.#run("systemd-analyze", [
      "--user",
      "verify",
      ...preview.files.map((file) => file.path),
    ]);
    await this.#run("systemctl", ["--user", "daemon-reload"]);
    await this.#run("systemctl", [
      "--user",
      "enable",
      "--now",
      `${preview.artifactId}.timer`,
    ]);
    const inspection = await this.inspect(plan);
    if (!inspection.installed || !inspection.enabled)
      throw new Error("systemd timer read-back failed");
  }

  async inspect(plan: ResetPlan): Promise<SchedulerInspection> {
    const name = artifactName(plan.planId);
    const result = await this.#run(
      "systemctl",
      [
        "--user",
        "show",
        `${name}.timer`,
        "--property=LoadState,UnitFileState,ActiveState",
      ],
      { allowFailure: true },
    );
    return {
      installed:
        result.exitCode === 0 && result.stdout.includes("LoadState=loaded"),
      enabled: result.stdout.includes("UnitFileState=enabled"),
      detail:
        result.exitCode === 0
          ? "loaded user timer"
          : "user timer not registered",
    };
  }

  async remove(plan: ResetPlan): Promise<void> {
    const name = artifactName(plan.planId);
    await this.#run(
      "systemctl",
      ["--user", "disable", "--now", `${name}.timer`],
      {
        allowFailure: true,
      },
    );
    await Promise.all([
      rm(join(this.#paths.schedulerDirectory, `${name}.service`), {
        force: true,
      }),
      rm(join(this.#paths.schedulerDirectory, `${name}.timer`), {
        force: true,
      }),
    ]);
    await this.#run("systemctl", ["--user", "daemon-reload"], {
      allowFailure: true,
    });
  }
}

function artifactName(planId: string): string {
  return `resetrail-${planId.replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;
}

function renderService(plan: ResetPlan, action: ExecSpec): string {
  const environment = Object.entries(action.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  const command = [action.command, ...action.arguments]
    .map(systemdQuote)
    .join(" ");
  return `[Unit]
Description=Resetrail exact reset ${plan.creditSelector}
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
${environment}
ExecStart=${command}
TimeoutStartSec=45s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${systemdQuote(action.stateDirectory)} ${systemdQuote(action.codexHome)}
UMask=0077
`;
}

function renderTimer(plan: ResetPlan): string {
  const calendars = plan.scheduler.triggerTimesUtc
    .map((value) => `OnCalendar=${formatSystemdCalendar(value)}`)
    .join("\n");
  return `[Unit]
Description=Schedule Resetrail exact reset ${plan.creditSelector}

[Timer]
Unit=${artifactName(plan.planId)}.service
${calendars}
AccuracySec=1s
RandomizedDelaySec=0
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function formatSystemdCalendar(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
}

export async function readSystemdArtifact(path: string): Promise<string> {
  return readFile(path, "utf8");
}
