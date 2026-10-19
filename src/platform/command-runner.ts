import { spawn } from "node:child_process";

import { SafetyError } from "../domain/errors.js";

export type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type CommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options?: { timeoutMilliseconds?: number; allowFailure?: boolean },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (
  executable,
  arguments_,
  options = {},
) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-32_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
    };
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const exitCode = !timedOut && signal === null ? (code ?? 1) : 1;
      const result = { stdout, stderr, exitCode };
      if (exitCode !== 0 && options.allowFailure !== true) {
        reject(
          new SafetyError(
            `Native scheduler command failed: ${executable}.`,
            "scheduler_command_failed",
          ),
        );
      } else resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        child.kill("SIGKILL");
        // Descendants can inherit these pipes after the direct child exits.
        // Bound our wait without claiming ownership of arbitrary process trees.
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, "SIGKILL");
      }, 250);
    }, options.timeoutMilliseconds ?? 30_000);
    child.once("error", (error) => {
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once("close", finish);
  });
