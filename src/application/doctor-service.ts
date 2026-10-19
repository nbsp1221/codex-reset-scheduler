import { execFile } from "node:child_process";

export type DoctorCheck = Readonly<{
  name: string;
  required: boolean;
  ok: boolean;
  hint: string | null;
}>;

export type DoctorSchedulerReport = Readonly<{
  platform: NodeJS.Platform;
  scheduler: string;
  ready: boolean;
  checks: readonly DoctorCheck[];
}>;

export type DoctorCommandRunner = (
  executable: string,
  arguments_: readonly string[],
) => Promise<string>;

export async function inspectSchedulerEnvironment(
  platform: NodeJS.Platform = process.platform,
  run: DoctorCommandRunner = runCommand,
): Promise<DoctorSchedulerReport> {
  const specifications = checksFor(platform);
  const checks: DoctorCheck[] = [];
  for (const specification of specifications) {
    try {
      const output = await run(
        specification.executable,
        specification.arguments,
      );
      const semanticOk = specification.accept(output);
      checks.push({
        name: specification.name,
        required: specification.required,
        ok: semanticOk,
        hint: semanticOk ? null : specification.hint,
      });
    } catch {
      checks.push({
        name: specification.name,
        required: specification.required,
        ok: false,
        hint: specification.hint,
      });
    }
  }
  return {
    platform,
    scheduler: schedulerName(platform),
    ready: checks.every((check) => !check.required || check.ok),
    checks,
  };
}

type CheckSpecification = Readonly<{
  name: string;
  executable: string;
  arguments: readonly string[];
  required: boolean;
  accept: (output: string) => boolean;
  hint: string;
}>;

function checksFor(platform: NodeJS.Platform): readonly CheckSpecification[] {
  const anyOutput = () => true;
  if (platform === "darwin") {
    return [
      {
        name: "launchd-user-domain",
        executable: "launchctl",
        arguments: ["print", `gui/${process.getuid?.() ?? 0}`],
        required: true,
        accept: anyOutput,
        hint: "Run codex-reset-scheduler from an active logged-in GUI user session.",
      },
      {
        name: "plist-validator",
        executable: "plutil",
        arguments: ["-help"],
        required: true,
        accept: anyOutput,
        hint: "Install the macOS plutil utility.",
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        name: "task-scheduler",
        executable: "schtasks.exe",
        arguments: ["/Query", "/FO", "CSV", "/NH"],
        required: true,
        accept: anyOutput,
        hint: "Ensure Windows Task Scheduler is available to the current user.",
      },
    ];
  }
  return [
    {
      name: "systemd-user-manager",
      executable: "systemctl",
      arguments: ["--user", "show-environment"],
      required: true,
      accept: anyOutput,
      hint: "Start or enable the per-user systemd manager.",
    },
    {
      name: "systemd-unit-validator",
      executable: "systemd-analyze",
      arguments: ["--user", "--version"],
      required: true,
      accept: anyOutput,
      hint: "Install systemd user tooling.",
    },
    {
      name: "clock-synchronized",
      executable: "timedatectl",
      arguments: ["show", "--property=NTPSynchronized", "--value"],
      required: false,
      accept: (output) => output.trim().toLowerCase() === "yes",
      hint: "Enable reliable system clock synchronization before arming.",
    },
    {
      name: "linger-enabled",
      executable: "loginctl",
      arguments: [
        "show-user",
        String(process.getuid?.() ?? process.env.USER ?? ""),
        "--property=Linger",
        "--value",
      ],
      required: false,
      accept: (output) => output.trim().toLowerCase() === "yes",
      hint: "Enable linger if schedules must survive logout.",
    },
  ];
}

function schedulerName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "task-scheduler";
  return "systemd";
}

function runCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...arguments_],
      { timeout: 5_000, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) reject(new Error(error.message, { cause: error }));
        else resolve(stdout);
      },
    );
  });
}
