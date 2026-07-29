import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ResetPlan } from "../domain/types.js";
import type { ManagedPaths } from "../persistence/paths.js";
import type { CommandRunner } from "../platform/command-runner.js";
import { xmlEscape } from "./escaping.js";
import type {
  ExecSpec,
  SchedulerAdapter,
  SchedulerInspection,
  SchedulerPreview,
} from "./types.js";
import { atomicWriteText } from "./write.js";

export class LaunchdScheduler implements SchedulerAdapter {
  readonly #paths: ManagedPaths;
  readonly #run: CommandRunner;
  readonly #uid: number;

  constructor(
    paths: ManagedPaths,
    run: CommandRunner,
    uid = process.getuid?.() ?? 0,
  ) {
    this.#paths = paths;
    this.#run = run;
    this.#uid = uid;
  }

  preview(plan: ResetPlan, action: ExecSpec): SchedulerPreview {
    const label = labelFor(plan.planId);
    const path = join(this.#paths.schedulerDirectory, `${label}.plist`);
    return {
      platform: "launchd",
      artifactId: label,
      files: [{ path, content: renderPlist(label, plan, action) }],
      registration: {
        executable: "/bin/launchctl",
        arguments: ["bootstrap", `gui/${this.#uid}`, path],
      },
    };
  }

  async install(plan: ResetPlan, action: ExecSpec): Promise<void> {
    const preview = this.preview(plan, action);
    const file = preview.files[0];
    if (file === undefined) throw new Error("launchd preview is empty");
    await mkdir(this.#paths.schedulerDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await atomicWriteText(file.path, file.content, 0o600);
    await this.#run("/usr/bin/plutil", ["-lint", file.path]);
    await this.#run(
      "/bin/launchctl",
      ["bootout", `gui/${this.#uid}/${preview.artifactId}`],
      {
        allowFailure: true,
      },
    );
    await this.#run("/bin/launchctl", preview.registration.arguments);
    if (!(await this.inspect(plan)).installed)
      throw new Error("launchd read-back failed");
  }

  async inspect(plan: ResetPlan): Promise<SchedulerInspection> {
    const label = labelFor(plan.planId);
    const result = await this.#run(
      "/bin/launchctl",
      ["print", `gui/${this.#uid}/${label}`],
      {
        allowFailure: true,
      },
    );
    return {
      installed: result.exitCode === 0,
      enabled: result.exitCode === 0,
      detail:
        result.exitCode === 0
          ? "registered LaunchAgent"
          : "LaunchAgent not registered",
    };
  }

  async remove(plan: ResetPlan): Promise<void> {
    const label = labelFor(plan.planId);
    await this.#run(
      "/bin/launchctl",
      ["bootout", `gui/${this.#uid}/${label}`],
      {
        allowFailure: true,
      },
    );
    await rm(join(this.#paths.schedulerDirectory, `${label}.plist`), {
      force: true,
    });
  }
}

function labelFor(planId: string): string {
  return `dev.resetrail.plan.${planId.replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;
}

function renderPlist(label: string, plan: ResetPlan, action: ExecSpec): string {
  const argumentsXml = [action.command, ...action.arguments]
    .map((value) => `      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(action.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const calendars = plan.scheduler.triggerTimesUtc
    .map((value) => {
      const date = new Date(value);
      return `      <dict>
        <key>Month</key><integer>${date.getMonth() + 1}</integer>
        <key>Day</key><integer>${date.getDate()}</integer>
        <key>Hour</key><integer>${date.getHours()}</integer>
        <key>Minute</key><integer>${date.getMinutes()}</integer>
      </dict>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${calendars}
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(action.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(action.stderrPath)}</string>
</dict>
</plist>
`;
}
