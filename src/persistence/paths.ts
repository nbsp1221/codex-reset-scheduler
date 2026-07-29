import { homedir } from "node:os";
import { join } from "node:path";

import type { SchedulerPlatform } from "../domain/types.js";

export type ManagedPaths = Readonly<{
  platform: SchedulerPlatform;
  stateDirectory: string;
  stateFile: string;
  lockDirectory: string;
  runtimeDirectory: string;
  logDirectory: string;
  auditLog: string;
  schedulerDirectory: string;
}>;

export function managedPaths(
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): ManagedPaths {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  if (platform === "darwin") {
    const stateDirectory = join(
      home,
      "Library",
      "Application Support",
      "Resetrail",
    );
    const logDirectory = join(home, "Library", "Logs", "Resetrail");
    return common(
      "launchd",
      stateDirectory,
      logDirectory,
      join(home, "Library", "LaunchAgents"),
    );
  }
  if (platform === "win32") {
    const base = environment.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const stateDirectory = join(base, "Resetrail");
    return common(
      "task-scheduler",
      stateDirectory,
      join(stateDirectory, "logs"),
      "\\Resetrail",
    );
  }
  const stateBase = environment.XDG_STATE_HOME ?? join(home, ".local", "state");
  const configBase = environment.XDG_CONFIG_HOME ?? join(home, ".config");
  const stateDirectory = join(stateBase, "resetrail");
  return common(
    "systemd",
    stateDirectory,
    join(stateDirectory, "logs"),
    join(configBase, "systemd", "user"),
  );
}

function common(
  platform: SchedulerPlatform,
  stateDirectory: string,
  logDirectory: string,
  schedulerDirectory: string,
): ManagedPaths {
  return {
    platform,
    stateDirectory,
    stateFile: join(stateDirectory, "state.json"),
    lockDirectory: join(stateDirectory, ".lock"),
    runtimeDirectory: join(stateDirectory, "runtime"),
    logDirectory,
    auditLog: join(logDirectory, "events.jsonl"),
    schedulerDirectory,
  };
}

export function defaultCodexHome(
  environment = process.env,
  home = homedir(),
): string {
  return environment.CODEX_HOME ?? join(home, ".codex");
}
