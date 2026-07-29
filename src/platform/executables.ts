import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

import { SafetyError } from "../domain/errors.js";

export async function resolveExecutable(name: string): Promise<string> {
  if (name.includes("/") || name.includes("\\"))
    return validateExecutable(name);
  const path = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? executableExtensions() : [""];
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        return await validateExecutable(candidate);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new SafetyError(
    `${name} was not found on PATH.`,
    "executable_not_found",
  );
}

async function validateExecutable(path: string): Promise<string> {
  await access(
    path,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  return realpath(path);
}

function executableExtensions(): readonly string[] {
  const pathExt = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return [
    "",
    ...pathExt
      .split(";")
      .map((extension) => extension.toLocaleLowerCase("en-US")),
  ];
}

export async function executableVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-1_000);
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0)
        reject(
          new SafetyError(
            "Executable version check failed.",
            "version_check_failed",
          ),
        );
      else resolve(stdout.trim());
    });
  });
}
