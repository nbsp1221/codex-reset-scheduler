import { randomBytes, randomUUID } from "node:crypto";
import {
  open,
  lstat,
  mkdir,
  mkdtemp,
  link,
  readdir,
  rmdir,
  unlink,
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
// A permanent file fences out the previous mkdir/owner.json protocol.
const LOCK_PROTOCOL = "codex-reset-scheduler state lock v2\n";
const OWNER_MARKER =
  /^owner-v2\.([1-9][0-9]{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

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
    const lockPath = `${this.#paths.lockDirectory}.v2`;
    await ensureLockProtocol(this.#paths.lockDirectory, () => this.load());
    const marker = await acquireLock(lockPath);
    try {
      const loaded = await this.load();
      let current: InstallState;
      if (loaded === null) {
        if (!allowMissing)
          throw new SafetyError(
            "codex-reset-scheduler is not initialized.",
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
      await removeMarker(lockPath, marker);
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

async function ensureLockProtocol(
  path: string,
  loadState: () => Promise<InstallState | null>,
): Promise<void> {
  if (await hasLockProtocol(path)) return;
  const existing = await loadState();
  if (
    existing?.plans.some((plan) =>
      ["armed", "attempting", "settling", "paused"].includes(plan.status),
    )
  ) {
    throw new SafetyError(
      "Existing schedules must be disarmed with the previous version and old writers stopped before lock v2 migration. See docs/state-lock.md.",
      "state_lock_migration_required",
    );
  }
  // The gate is a snapshot check, not proof that all old writers have exited.
  // Publish a complete file without replacing an existing legacy directory.
  // Never remove this fence: old immutable workers must fail closed.
  const temporary = `${path}.protocol.${randomUUID()}`;
  try {
    await writeFile(temporary, LOCK_PROTOCOL, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(await hasLockProtocol(path))) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function hasLockProtocol(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (await readFile(path, "utf8")) === LOCK_PROTOCOL
    )
      return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  throw new SafetyError(
    "Legacy or unknown state lock. Stop old workers and follow docs/state-lock.md before recovery.",
    "state_lock_recovery_required",
  );
}

async function acquireLock(path: string): Promise<string> {
  await rejectSymlinkIfPresent(path, "state lock");
  const marker = `owner-v2.${process.pid}.${randomUUID()}`;
  const prepared = await mkdtemp(`${path}.prepare-`);
  try {
    // A terminated process or failed marker write cannot publish an ownerless
    // lock. Prepared directories are private and never considered active.
    await writeFile(join(prepared, marker), "", { mode: 0o600, flag: "wx" });
    const started = Date.now();
    while (Date.now() - started < LOCK_WAIT_MILLISECONDS) {
      try {
        await rename(prepared, path);
        return marker;
      } catch (error) {
        if (!(await isLockCollision(error, path))) throw error;
        if (await removeDeadLock(path)) continue;
        // The observed owner may release before the next probe. Retry within
        // the same budget instead of throwing the earlier collision error.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new SafetyError(
      "Another codex-reset-scheduler process holds the state lock; retry after it finishes. See docs/state-lock.md.",
      "state_locked",
    );
  } finally {
    await rm(prepared, { recursive: true, force: true });
  }
}

async function isLockCollision(error: unknown, path: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST" || code === "ENOTEMPTY") return true;
  // MoveFileEx can report EPERM for an existing directory on Windows. Do not
  // treat EPERM as contention unless that directory is actually observed.
  if (process.platform !== "win32" || code !== "EPERM") return false;
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (inspectionError) {
    if (isNotFound(inspectionError)) return false;
    throw inspectionError;
  }
}

async function removeDeadLock(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw lockRecoveryRequired();
    const entries = await readdir(path);
    // Only v2 writers use this directory. A release interrupted between
    // unlink and rmdir can leave it empty; publishing a nonempty directory
    // or nonrecursive rmdir is safe even if another writer wins this race.
    if (entries.length === 0) return await removeEmptyLock(path);
    const marker = entries[0];
    const match = marker?.match(OWNER_MARKER);
    if (entries.length !== 1 || !marker || !match) throw lockRecoveryRequired();
    const pid = Number(match[1]);
    const owner = await lstat(join(path, marker));
    if (!owner.isFile() || owner.isSymbolicLink() || pid > 2_147_483_647)
      throw lockRecoveryRequired();
    if (processAlive(pid)) return false;
    return await removeMarker(path, marker);
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
}

async function removeMarker(path: string, marker: string): Promise<boolean> {
  try {
    // The unique filename is the generation check. A delayed reaper cannot
    // unlink a successor's marker; never recursively remove the shared path.
    await unlink(join(path, marker));
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  return removeEmptyLock(path);
}

async function removeEmptyLock(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

function lockRecoveryRequired(): SafetyError {
  return new SafetyError(
    "Unrecognized state lock contents. Stop workers and follow docs/state-lock.md before recovery.",
    "state_lock_recovery_required",
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. EPERM and unknown probe failures preserve it.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
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
