import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResetPlan } from "../domain/types.js";
import type { CommandRunner } from "../platform/command-runner.js";
import type {
  ExecSpec,
  SchedulerAdapter,
  SchedulerInspection,
  SchedulerPreview,
} from "./types.js";
import { windowsQuoteArgument, xmlEscape } from "./escaping.js";
import { atomicWriteText } from "./write.js";

export class WindowsScheduler implements SchedulerAdapter {
  readonly #run: CommandRunner;
  readonly #userId: string;

  constructor(run: CommandRunner, userId: string) {
    this.#run = run;
    this.#userId = userId;
  }

  preview(plan: ResetPlan, action: ExecSpec): SchedulerPreview {
    const name = taskName(plan.planId);
    const path = join(tmpdir(), `resetrail-${plan.planId}.xml`);
    return {
      platform: "task-scheduler",
      artifactId: name,
      files: [{ path, content: renderTask(name, plan, action, this.#userId) }],
      registration: {
        executable: "schtasks.exe",
        arguments: ["/Create", "/XML", path, "/TN", name, "/F"],
      },
    };
  }

  async install(plan: ResetPlan, action: ExecSpec): Promise<void> {
    const preview = this.preview(plan, action);
    const file = preview.files[0];
    if (file === undefined) throw new Error("Task Scheduler preview is empty");
    await this.#ensureFolder();
    await mkdir(tmpdir(), { recursive: true });
    await atomicWriteText(file.path, file.content, 0o600);
    try {
      await this.#run(
        preview.registration.executable,
        preview.registration.arguments,
      );
      if (!(await this.inspect(plan)).installed)
        throw new Error("Task Scheduler read-back failed");
    } finally {
      await rm(file.path, { force: true });
    }
  }

  async inspect(plan: ResetPlan): Promise<SchedulerInspection> {
    const name = taskName(plan.planId);
    const result = await this.#run(
      "schtasks.exe",
      ["/Query", "/TN", name, "/XML"],
      {
        allowFailure: true,
      },
    );
    return {
      installed: result.exitCode === 0,
      enabled: result.exitCode === 0,
      detail:
        result.exitCode === 0
          ? "registered current-user task"
          : "current-user task not registered",
    };
  }

  async remove(plan: ResetPlan): Promise<void> {
    await this.#run(
      "schtasks.exe",
      ["/Delete", "/TN", taskName(plan.planId), "/F"],
      {
        allowFailure: true,
      },
    );
    await this.#removeFolderIfEmpty();
  }

  async #ensureFolder(): Promise<void> {
    await this.#run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop';$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$r=$s.GetFolder('\\');try{$null=$r.GetFolder('Resetrail')}catch{$null=$r.CreateFolder('Resetrail')}",
    ]);
  }

  async #removeFolderIfEmpty(): Promise<void> {
    await this.#run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop';$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$r=$s.GetFolder('\\');$r.DeleteFolder('Resetrail',0)",
      ],
      { allowFailure: true },
    );
  }
}

function taskName(planId: string): string {
  return `\\Resetrail\\${planId.replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;
}

function renderTask(
  name: string,
  plan: ResetPlan,
  action: ExecSpec,
  userId: string,
): string {
  const end = new Date(plan.expiresAt * 1_000).toISOString();
  const triggers = plan.scheduler.triggerTimesUtc
    .map(
      (start, index) => `    <TimeTrigger id="resetrail-${index}">
      <StartBoundary>${xmlEscape(start)}</StartBoundary>
      <EndBoundary>${xmlEscape(end)}</EndBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>`,
    )
    .join("\n");
  const arguments_ = action.arguments.map(windowsQuoteArgument).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Resetrail exact reset ${xmlEscape(plan.creditSelector)}</Description>
    <URI>${xmlEscape(name)}</URI>
  </RegistrationInfo>
  <Triggers>
${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT45S</ExecutionTimeLimit>
    <DeleteExpiredTaskAfter>PT1M</DeleteExpiredTaskAfter>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(action.command)}</Command>
      <Arguments>${xmlEscape(arguments_)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
