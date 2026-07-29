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
    const timeout = setTimeout(
      () => child.kill("SIGTERM"),
      options.timeoutMilliseconds ?? 30_000,
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const exitCode = signal === null ? (code ?? 1) : 1;
      const result = { stdout, stderr, exitCode };
      if (exitCode !== 0 && options.allowFailure !== true) {
        reject(
          new SafetyError(
            `Native scheduler command failed: ${executable}.`,
            "scheduler_command_failed",
          ),
        );
      } else resolve(result);
    });
  });
