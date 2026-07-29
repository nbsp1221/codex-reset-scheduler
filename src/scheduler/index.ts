import { homedir } from "node:os";

import { SafetyError } from "../domain/errors.js";
import type { ManagedPaths } from "../persistence/paths.js";
import { runCommand, type CommandRunner } from "../platform/command-runner.js";
import { LaunchdScheduler } from "./launchd.js";
import { SystemdScheduler } from "./systemd.js";
import type { SchedulerAdapter } from "./types.js";
import { WindowsScheduler } from "./windows.js";

export function schedulerAdapter(
  paths: ManagedPaths,
  options: { run?: CommandRunner; userId?: string; uid?: number } = {},
): SchedulerAdapter {
  const run = options.run ?? runCommand;
  if (paths.platform === "systemd") return new SystemdScheduler(paths, run);
  if (paths.platform === "launchd")
    return new LaunchdScheduler(paths, run, options.uid);
  const userId = options.userId ?? windowsUserId();
  return new WindowsScheduler(run, userId);
}

function windowsUserId(): string {
  const username = process.env.USERNAME;
  if (username === undefined || username.length === 0) {
    throw new SafetyError(
      "Windows user identity is unavailable.",
      "user_identity_unavailable",
    );
  }
  const domain = process.env.USERDOMAIN;
  return domain === undefined || domain.length === 0
    ? username
    : `${domain}\\${username}`;
}

export function schedulerHome(): string {
  return homedir();
}
