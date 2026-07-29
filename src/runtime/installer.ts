import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { SafetyError } from "../domain/errors.js";
import type { ManagedPaths } from "../persistence/paths.js";
import { VERSION } from "../version.js";

export type RuntimeSnapshot = Readonly<{
  version: string;
  sha256: string;
  directory: string;
  entrypoint: string;
}>;

export async function installRuntimeSnapshot(
  paths: ManagedPaths,
  sourceDirectory = defaultSourceDirectory(),
): Promise<RuntimeSnapshot> {
  const source = await realpath(sourceDirectory);
  const sha256 = await hashDirectory(source);
  const directory = join(paths.runtimeDirectory, `${VERSION}-${sha256}`);
  const entrypoint = join(directory, "cli.js");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyTree(source, directory);
  if (!(await lstat(entrypoint)).isFile()) {
    throw new SafetyError(
      "Runtime snapshot has no CLI entrypoint.",
      "runtime_incomplete",
    );
  }
  const copiedHash = await hashDirectory(directory);
  if (copiedHash !== sha256) {
    throw new SafetyError(
      "Runtime snapshot hash mismatch.",
      "runtime_hash_mismatch",
    );
  }
  return { version: VERSION, sha256, directory, entrypoint };
}

export async function hashDirectory(directory: string): Promise<string> {
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    const path = relative(directory, file).split("\\").join("/");
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function defaultSourceDirectory(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return dirname(current);
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const output: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SafetyError(
        "Runtime source must not contain symlinks.",
        "unsafe_runtime_source",
      );
    }
    if (entry.isDirectory()) output.push(...(await listFiles(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function copyTree(source: string, destination: string): Promise<void> {
  for (const file of await listFiles(source)) {
    const relativePath = relative(source, file);
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(file, target);
  }
  if (basename(destination).length === 0) {
    throw new SafetyError(
      "Runtime destination is invalid.",
      "unsafe_runtime_destination",
    );
  }
}
