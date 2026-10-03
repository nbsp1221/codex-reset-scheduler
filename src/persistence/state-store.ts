import { randomBytes, randomUUID } from "node:crypto";
import {
  open,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { ProtocolError, SafetyError } from "../domain/errors.js";
import { decodeInstallState } from "../domain/state-schema.js";
import type { InstallState } from "../domain/types.js";
import type { ManagedPaths } from "./paths.js";

const LOCK_WAIT_MILLISECONDS = 5_000;
const STALE_LOCK_MILLISECONDS = 120_000;

export type LockedState = Readonly<{
  get(): InstallState;
  save(state: InstallState): Promise<void>;
}>;

export class StateStore {
  readonly #paths: ManagedPaths;

  constructor(paths: ManagedPaths) {
    this.#paths = paths;
  }

  async load(): Promise<InstallState | null> {
    await rejectSymlinkIfPresent(this.#paths.stateFile, "state file");
    try {
      return decodeInstallState(
        JSON.parse(await readFile(this.#paths.stateFile, "utf8")) as unknown,
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("State file is not valid JSON.");
    }
  }

  async initialize(): Promise<InstallState> {
    return this.withLock(async (locked) => {
      const existing = locked.get();
      if (existing.installId.length > 0) return existing;
      const initial: InstallState = {
        schemaVersion: 1,
        revision: 0,
        installId: randomUUID(),
        accountSalt: randomBytes(32).toString("hex"),
        plans: [],
      };
      await locked.save(initial);
      return initial;
    }, true);
  }

  async withLock<T>(
    operation: (locked: LockedState) => Promise<T>,
    allowMissing = false,
  ): Promise<T> {
    await ensurePrivateDirectory(this.#paths.stateDirectory);
    await acquireLock(this.#paths.lockDirectory);
    try {
      const loaded = await this.load();
      let current: InstallState;
      if (loaded === null) {
        if (!allowMissing)
          throw new SafetyError(
            "Codex ResetPilot is not initialized.",
            "not_initialized",
          );
        current = {
          schemaVersion: 1,
          revision: 0,
          installId: "",
          accountSalt: "",
          plans: [],
        };
      } else current = loaded;
      const locked: LockedState = {
        get: () => current,
        save: async (state) => {
          if (state.revision < current.revision) {
            throw new SafetyError(
              "State revision moved backwards.",
              "stale_state",
            );
          }
          await atomicWriteJson(this.#paths.stateFile, state);
          current = state;
        },
      };
      return await operation(locked);
    } finally {
      await rm(this.#paths.lockDirectory, { recursive: true, force: true });
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SafetyError(
      "Managed state directory is unsafe.",
      "unsafe_state_path",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    await import("node:fs/promises").then(({ chmod }) => chmod(path, 0o700));
  }
}

async function rejectSymlinkIfPresent(
  path: string,
  label: string,
): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new SafetyError(
        `${label} must not be a symbolic link.`,
        "unsafe_state_path",
      );
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function acquireLock(path: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < LOCK_WAIT_MILLISECONDS) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(
        join(path, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), nonce: randomUUID() })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await removeStaleLock(path)) continue;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new SafetyError(
    "Another Codex ResetPilot process holds the state lock.",
    "state_locked",
  );
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(
      await readFile(join(path, "owner.json"), "utf8"),
    ) as {
      pid?: unknown;
      createdAt?: unknown;
    };
    if (typeof owner.pid !== "number" || typeof owner.createdAt !== "string")
      return false;
    const age = Date.now() - new Date(owner.createdAt).getTime();
    if (age < STALE_LOCK_MILLISECONDS || processAlive(owner.pid)) return false;
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function atomicWriteJson(
  path: string,
  state: InstallState,
): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.state.${randomUUID()}.tmp`);
  await rejectSymlinkIfPresent(path, "state file");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
